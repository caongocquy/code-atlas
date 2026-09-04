import path from "node:path";

import type {
  ConnectionStatus,
  IntegrationAdapter,
  IntegrationChange,
  IntegrationContext,
  DurableMcpLaunch,
  IntegrationOptions,
} from "../../core/integration/integration.types.js";
import { CODE_ATLAS_ARGS, CODE_ATLAS_COMMAND, CODE_ATLAS_NAME, isCodeAtlasCommand } from "./agent-entry.js";
import { codexConfigPath } from "./config-paths.js";
import { validateConfiguredLaunch } from "./mcp-launcher.js";
import { readTomlConfig, removeTomlValue, writeTomlValue } from "./toml-config.js";
import { commandAvailable, type ResolvedIntegrationEnvironment } from "./integration-environment.js";

const displayName = "Codex";

export class CodexIntegration implements IntegrationAdapter {
  readonly descriptor = {
    id: "codex" as const,
    displayName,
    scopes: ["user"] as const,
    configFormat: "toml" as const,
    supportsEnablement: true,
  };

  constructor(private readonly environment: ResolvedIntegrationEnvironment) {}

  async detect(_context: IntegrationContext) {
    return (await commandAvailable("codex", this.environment))
      ? { state: "installed" as const, evidence: "codex executable found on PATH" }
      : { state: "not_detected" as const, evidence: "codex executable not found on PATH" };
  }

  async status(options: IntegrationOptions): Promise<ConnectionStatus> {
    assertUserScope(options);
    const configPath = codexConfigPath(this.environment);
    try {
      const config = await readTomlConfig(configPath);
      const servers = config.value.mcp_servers;
      if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
        throw new Error("Codex mcp_servers must be a table.");
      }
      const entry = servers && typeof servers === "object" && !Array.isArray(servers)
        ? (servers as Record<string, unknown>)[CODE_ATLAS_NAME]
        : undefined;
      const launch = codexLaunchFromEntry(entry);
      const disabled = isDisabledEntry(entry);
      const validation = !disabled && launch && isAbsoluteCodeAtlasLaunch(launch)
        ? await validateConfiguredLaunch(launch)
        : undefined;
      const configured = !disabled && (isCodeAtlasCommand(
        entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>).command : undefined,
        entry && typeof entry === "object" && !Array.isArray(entry) ? (entry as Record<string, unknown>).args : undefined,
      ) || validation === "valid");
      const stale = validation === "stale" || validation === "ephemeral";
      const warnings = stale
        ? ["The CodeAtlas MCP launcher is stale (Node or the CLI entrypoint is missing); run `code-atlas connect codex` again."]
        : !configured && entry !== undefined && !disabled
          ? ["A CodeAtlas-named entry exists but does not point to a valid CodeAtlas MCP launch."]
          : [];
      return connectionValue(configPath, configured, warnings, stale ? "stale" : entry !== undefined && !configured && !disabled ? "invalid_config" : undefined, entry !== undefined);
    } catch (error) {
      return connectionValue(configPath, false, [error instanceof Error ? error.message : String(error)], "invalid_config", true);
    }
  }

  async connect(options: IntegrationOptions, launch: DurableMcpLaunch): Promise<IntegrationChange> {
    assertUserScope(options);
    const configPath = codexConfigPath(this.environment);
    const current = await readTomlConfig(configPath);
    const servers = current.value.mcp_servers;
    const entry = servers && typeof servers === "object" && !Array.isArray(servers)
      ? (servers as Record<string, unknown>)[CODE_ATLAS_NAME]
      : undefined;
    if (entry !== undefined && !isManagedCodexEntry(entry)) {
      throw new Error("Refusing to replace an unrelated CodeAtlas-named Codex configuration.");
    }
    const changed = await writeTomlValue(configPath, CODE_ATLAS_NAME, {
      command: launch.command,
      args: launch.args,
      enabled: true,
    });
    return change(this, "connect", changed, configPath, options);
  }

  async disconnect(options: IntegrationOptions): Promise<IntegrationChange> {
    assertUserScope(options);
    const configPath = codexConfigPath(this.environment);
    const current = await readTomlConfig(configPath);
    const servers = current.value.mcp_servers;
    const entry = servers && typeof servers === "object" && !Array.isArray(servers)
      ? (servers as Record<string, unknown>)[CODE_ATLAS_NAME]
      : undefined;
    const changed = entry !== undefined && isManagedCodexEntry(entry)
      ? await removeTomlValue(configPath, CODE_ATLAS_NAME)
      : false;
    return change(this, "disconnect", changed, configPath, options);
  }
}

function assertUserScope(options: IntegrationOptions): void {
  if (options.scope === "project") throw new Error("Codex integration supports user scope only.");
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

function connectionValue(
  configPath: string,
  configured: boolean,
  warnings: string[],
  invalidState?: ConnectionStatus["state"],
  managedConfigPresent = configured,
): ConnectionStatus {
  return {
    state: invalidState ?? (configured ? "connected" : "disconnected"),
    configPath,
    scope: "user",
    managedConfigPresent,
    warnings,
  };
}

function isDisabledEntry(value: unknown): boolean {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    && (value as Record<string, unknown>).enabled === false;
}

function isManagedCodexEntry(value: unknown): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return isCodeAtlasCommand(entry.command, entry.args) || isAbsoluteCodeAtlasLaunch(codexLaunchFromEntry(value));
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
    id: adapter.descriptor.id,
    displayName: adapter.descriptor.displayName,
    operation,
    changed,
    status: { ...status, configPath },
    strictGuidanceChanged: false,
  };
}
