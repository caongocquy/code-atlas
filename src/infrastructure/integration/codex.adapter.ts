import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { AgentIntegration, IntegrationChange, IntegrationOptions, IntegrationStatus } from "../../core/integration/integration.types.js";
import { CODE_ATLAS_ARGS, CODE_ATLAS_COMMAND, CODE_ATLAS_NAME, isCodeAtlasCommand } from "./agent-entry.js";
import { codexConfigPath } from "./config-paths.js";
import { readTomlConfig, removeTomlValue, writeTomlValue } from "./toml-config.js";
import { commandAvailable, type ResolvedIntegrationEnvironment } from "./integration-environment.js";

const displayName = "Codex";

export class CodexIntegration implements AgentIntegration {
  readonly id = "codex" as const;
  readonly displayName = displayName;

  constructor(private readonly environment: ResolvedIntegrationEnvironment) {}

  async status(options: IntegrationOptions): Promise<IntegrationStatus> {
    assertUserScope(options);
    const configPath = codexConfigPath(this.environment);
    const detected = await commandAvailable("codex", this.environment);
    try {
      const config = await readTomlConfig(configPath);
      const servers = config.value.mcp_servers;
      if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
        throw new Error("Codex mcp_servers must be a table.");
      }
      const entry = servers && typeof servers === "object" && !Array.isArray(servers)
        ? (servers as Record<string, unknown>)[CODE_ATLAS_NAME]
        : undefined;
      const configured = await isCodexEntry(entry);
      const launch = codexLaunchFromEntry(entry);
      const stale = isAbsoluteCodeAtlasLaunch(launch) && !configured;
      const warnings = stale
        ? ["The CodeAtlas MCP launcher is stale (Node or the CLI entrypoint is missing); run `code-atlas connect codex` again."]
        : !configured && entry !== undefined
          ? ["A CodeAtlas-named entry exists but does not point to a valid CodeAtlas MCP launch."]
          : [];
      return statusValue(
        this.id,
        detected || config.file.exists,
        configPath,
        configured,
        !stale,
        warnings,
        stale ? "stale" : undefined,
        launch,
      );
    } catch (error) {
      return statusValue(this.id, detected || await exists(configPath), configPath, false, false, [error instanceof Error ? error.message : String(error)], "invalid_config");
    }
  }

  async install(options: IntegrationOptions): Promise<IntegrationChange> {
    assertUserScope(options);
    const configPath = codexConfigPath(this.environment);
    const launch = await resolveCodeAtlasMcpLaunch();
    const changed = await writeTomlValue(configPath, CODE_ATLAS_NAME, {
      command: launch.command,
      args: launch.args,
      enabled: true,
    });
    return change(this, "install", changed, configPath, options);
  }

  async uninstall(options: IntegrationOptions): Promise<IntegrationChange> {
    assertUserScope(options);
    const changed = await removeTomlValue(codexConfigPath(this.environment), CODE_ATLAS_NAME);
    return change(this, "uninstall", changed, codexConfigPath(this.environment), options);
  }
}

function assertUserScope(options: IntegrationOptions): void {
  if (options.scope === "project") throw new Error("Codex integration supports user scope only.");
}

async function isCodexEntry(value: unknown): Promise<boolean> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  if (entry.enabled === false) return false;
  if (isCodeAtlasCommand(entry.command, entry.args)) return true;

  const launch = codexLaunchFromEntry(entry);
  return launch !== undefined
    && isNodeExecutable(launch.command)
    && !isEphemeralCodeAtlasPath(launch.command)
    && !isEphemeralCodeAtlasPath(launch.args[0])
    && await isFile(launch.command)
    && await isFile(launch.args[0])
    && await isValidCwd(entry.cwd);
}

function codexLaunchFromEntry(value: unknown): { command: string; args: string[] } | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const entry = value as Record<string, unknown>;
  if (typeof entry.command !== "string" || !Array.isArray(entry.args)) return undefined;
  if (!entry.args.every((arg): arg is string => typeof arg === "string")) return undefined;
  return { command: entry.command, args: entry.args };
}

function isAbsoluteCodeAtlasLaunch(
  launch: { command: string; args: string[] } | undefined,
): boolean {
  return launch !== undefined
    && path.isAbsolute(launch.command)
    && launch.args.length === 2
    && path.isAbsolute(launch.args[0])
    && launch.args[1] === "mcp";
}

export async function resolveCodeAtlasMcpLaunch(
  moduleUrl = import.meta.url,
): Promise<{ command: string; args: string[] }> {
  const command = process.execPath;
  const packageRoot = path.resolve(path.dirname(fileURLToPath(moduleUrl)), "../../..");
  const cliPath = path.join(packageRoot, "dist", "cli.js");
  if (!path.isAbsolute(command) || !await isFile(command)) {
    throw new Error(`Node executable is not available at an absolute path: ${command}`);
  }
  if (!await isFile(cliPath)) {
    throw new Error(`Compiled CodeAtlas CLI is not available at ${cliPath}; build the package before installing Codex integration.`);
  }
  if (isEphemeralCodeAtlasPath(command) || isEphemeralCodeAtlasPath(cliPath)) {
    throw new Error(`CodeAtlas is running from an ephemeral installation at ${cliPath}; install CodeAtlas durably before connecting Codex.`);
  }
  return { command, args: [cliPath, "mcp"] };
}

export function isEphemeralCodeAtlasPath(filePath: string): boolean {
  const absolutePath = path.resolve(filePath);
  const temporaryRoots = [tmpdir()];
  if (process.platform !== "win32") temporaryRoots.push("/tmp", "/private/tmp");
  if (temporaryRoots.some((root) => {
    const relative = path.relative(path.resolve(root), absolutePath);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  })) return true;
  const segments = absolutePath.split(path.sep).filter(Boolean).map((segment) => segment.toLowerCase());
  return segments.includes("_npx") || segments.includes(".npx") || segments.includes("dlx");
}

function isNodeExecutable(command: string): boolean {
  const name = path.basename(command).toLowerCase();
  return name === "node" || name === "node.exe" || name === "nodejs";
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function isValidCwd(value: unknown): Promise<boolean> {
  if (value === undefined) return true;
  if (typeof value !== "string" || !path.isAbsolute(value)) return false;
  try {
    return (await stat(value)).isDirectory();
  } catch {
    return false;
  }
}

function statusValue(
  id: "codex",
  detected: boolean,
  configPath: string,
  configured: boolean,
  valid: boolean,
  warnings: string[],
  invalidState?: IntegrationStatus["state"],
  launch?: { command: string; args: string[] },
): IntegrationStatus {
  return {
    id,
    displayName,
    state: invalidState ?? (configured ? "installed" : detected ? "not_installed" : "unavailable"),
    detected,
    configPath,
    scope: "user",
    codeAtlasMcpConfigured: configured,
    configurationValid: valid,
    command: launch?.command ?? CODE_ATLAS_COMMAND,
    args: launch?.args ?? [...CODE_ATLAS_ARGS],
    warnings,
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await import("node:fs/promises").then(({ access }) => access(filePath));
    return true;
  } catch {
    return false;
  }
}

async function change(
  adapter: CodexIntegration,
  operation: IntegrationChange["operation"],
  changed: boolean,
  configPath: string,
  options: IntegrationOptions,
): Promise<IntegrationChange> {
  const status = await adapter.status(options);
  return {
    id: adapter.id,
    displayName: adapter.displayName,
    operation,
    changed,
    status: { ...status, configPath },
    strictGuidanceChanged: false,
  };
}
