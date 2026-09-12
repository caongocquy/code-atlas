import fs from "node:fs/promises";
import path from "node:path";

import type {
  ConnectionStatus,
  DurableMcpLaunch,
  IntegrationAdapter,
  IntegrationChange,
  IntegrationContext,
  IntegrationOptions,
  IntegrationScope,
} from "../../core/integration/integration.types.js";
import { CODE_ATLAS_ARGS, CODE_ATLAS_COMMAND, CODE_ATLAS_NAME, isCodeAtlasCommand } from "./agent-entry.js";
import { openCodeConfigPath } from "./config-paths.js";
import { isJsonObject, readJsoncConfig, removeJsoncValue, writeJsoncValue } from "./jsonc-config.js";
import { configuredMcpLaunch, validateConfiguredLaunch } from "./mcp-launcher.js";
import { commandAvailable, type ResolvedIntegrationEnvironment } from "./integration-environment.js";

const displayName = "OpenCode";

export class OpenCodeIntegration implements IntegrationAdapter {
  readonly descriptor = {
    id: "opencode" as const,
    displayName,
    scopes: ["user", "project"] as const,
    configFormat: "jsonc" as const,
    supportsEnablement: true,
  };

  constructor(private readonly environment: ResolvedIntegrationEnvironment) {}

  async detect(_context: IntegrationContext) {
    return (await commandAvailable("opencode", this.environment))
      ? { state: "installed" as const, evidence: "opencode executable found on PATH" }
      : { state: "not_detected" as const, evidence: "opencode executable not found on PATH" };
  }

  async status(options: IntegrationOptions): Promise<ConnectionStatus> {
    const scope = options.scope ?? "user";
    const configPath = await existingPath(this.environment, scope);
    try {
      const config = await readJsoncConfig(configPath);
      const serverPath = mcpServerPath(config.value);
      const entry = serverPath ? valueAt(config.value, [...serverPath, CODE_ATLAS_NAME]) : undefined;
      const disabled = isDisabledEntry(entry);
      const launch = openCodeLaunchFromEntry(entry);
      const validation = !disabled && launch ? await validateConfiguredLaunch(launch) : undefined;
      const configured = !disabled && (isOpenCodeEntry(entry) || validation === "valid");
      const stale = validation === "stale" || validation === "ephemeral";
      const warnings = stale
        ? ["The CodeAtlas MCP launcher is stale; run `code-atlas connect opencode` again."]
        : !configured && entry !== undefined && !disabled
        ? ["A CodeAtlas-named entry exists but does not point to `code-atlas mcp`."]
        : [];
      return statusValue(scope, configPath, configured, warnings, stale ? "stale" : entry !== undefined && !configured && !disabled ? "invalid_config" : undefined, entry !== undefined);
    } catch (error) {
      return statusValue(scope, configPath, false, [error instanceof Error ? error.message : String(error)], "invalid_config", true);
    }
  }

  async connect(options: IntegrationOptions, launch: DurableMcpLaunch): Promise<IntegrationChange> {
    const scope = options.scope ?? "user";
    const configPath = await existingPath(this.environment, scope);
    const current = await readJsoncConfig(configPath);
    const serverPath = mcpServerPath(current.value) ?? ["mcp"];
    const existing = valueAt(current.value, [...serverPath, CODE_ATLAS_NAME]);
    if (existing !== undefined && !isOpenCodeManagedEntry(existing)) {
      throw new Error("Refusing to replace an unrelated CodeAtlas-named OpenCode configuration.");
    }
    const nested = serverPath.at(-1) === "servers";
    const changed = await writeJsoncValue(
      configPath,
      [...serverPath, CODE_ATLAS_NAME],
      nested
        ? { type: "local", command: [launch.command, ...launch.args] }
        : { type: "local", command: [launch.command, ...launch.args], enabled: true },
    );
    return {
      id: this.descriptor.id,
      displayName,
      operation: "connect",
      changed,
      status: await this.status(options),
      strictGuidanceChanged: false,
    };
  }

  async disconnect(options: IntegrationOptions): Promise<IntegrationChange> {
    const scope = options.scope ?? "user";
    const configPath = await existingPath(this.environment, scope);
    const current = await readJsoncConfig(configPath);
    const serverPath = mcpServerPath(current.value);
    const entry = serverPath ? valueAt(current.value, [...serverPath, CODE_ATLAS_NAME]) : undefined;
    const changed = serverPath && entry !== undefined && isOpenCodeManagedEntry(entry)
      ? await removeJsoncValue(configPath, [...serverPath, CODE_ATLAS_NAME])
      : false;
    return {
      id: this.descriptor.id,
      displayName,
      operation: "disconnect",
      changed,
      status: await this.status(options),
      strictGuidanceChanged: false,
    };
  }
}

function mcpServerPath(root: Record<string, unknown>): string[] | undefined {
  const mcp = root.mcp;
  if (mcp === undefined) return undefined;
  if (!isJsonObject(mcp)) throw new Error("OpenCode `mcp` must be an object");
  if (mcp.servers !== undefined) {
    if (!isJsonObject(mcp.servers)) throw new Error("OpenCode `mcp.servers` must be an object");
    return ["mcp", "servers"];
  }
  return ["mcp"];
}

function valueAt(root: Record<string, unknown>, segments: string[]): unknown {
  let current: unknown = root;
  for (const segment of segments) {
    if (!isJsonObject(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function isOpenCodeEntry(value: unknown): boolean {
  return isOpenCodeLegacyEntry(value) && isJsonObject(value) && value.disabled !== true && value.enabled !== false;
}

function isOpenCodeLegacyEntry(value: unknown): boolean {
  if (!isJsonObject(value) || value.type !== "local") return false;
  return isCodeAtlasCommand(
    Array.isArray(value.command) ? value.command[0] : undefined,
    Array.isArray(value.command) ? value.command.slice(1) : undefined,
  );
}

function openCodeLaunchFromEntry(value: unknown): DurableMcpLaunch | undefined {
  if (!isJsonObject(value) || value.type !== "local" || !Array.isArray(value.command)) return undefined;
  if (!value.command.every((part): part is string => typeof part === "string")) return undefined;
  return configuredMcpLaunch(value.command[0]!, value.command.slice(1));
}

function isDisabledEntry(value: unknown): boolean {
  return isJsonObject(value) && (value.disabled === true || value.enabled === false);
}

function isOpenCodeManagedEntry(value: unknown): boolean {
  return isOpenCodeLegacyEntry(value) || openCodeLaunchFromEntry(value) !== undefined;
}

function statusValue(
  scope: IntegrationScope,
  configPath: string,
  configured: boolean,
  warnings: string[],
  invalidState?: ConnectionStatus["state"],
  managedConfigPresent = configured,
): ConnectionStatus {
  return {
    state: invalidState ?? (configured ? "connected" : "disconnected"),
    configPath,
    scope,
    managedConfigPresent,
    warnings,
  };
}

async function existingPath(
  environment: ResolvedIntegrationEnvironment,
  scope: IntegrationScope,
): Promise<string> {
  const selected = openCodeConfigPath(environment, scope);
  const directory = path.dirname(selected);
  const candidates = scope === "project"
    ? [path.join(directory, "opencode.jsonc"), path.join(directory, "opencode.json")]
    : [path.join(directory, "opencode.json"), path.join(directory, "opencode.jsonc")];
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate;
  }
  return selected;
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
