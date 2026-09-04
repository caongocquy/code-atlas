import fs from "node:fs/promises";
import path from "node:path";

import type {
  ConnectionStatus,
  DurableMcpLaunch,
  IntegrationAdapter,
  IntegrationChange,
  IntegrationContext,
  IntegrationOptions,
} from "../../core/integration/integration.types.js";
import { CODE_ATLAS_ARGS, CODE_ATLAS_COMMAND, CODE_ATLAS_NAME, isCodeAtlasCommand } from "./agent-entry.js";
import { claudeConfigPath } from "./config-paths.js";
import { isJsonObject, readJsoncConfig, removeJsoncValue, writeJsoncValue } from "./jsonc-config.js";
import { validateConfiguredLaunch } from "./mcp-launcher.js";
import { commandAvailable, type ResolvedIntegrationEnvironment } from "./integration-environment.js";

const displayName = "Claude Code";

export class ClaudeIntegration implements IntegrationAdapter {
  readonly descriptor = {
    id: "claude" as const,
    displayName,
    scopes: ["project"] as const,
    configFormat: "jsonc" as const,
    supportsEnablement: false,
  };

  constructor(private readonly environment: ResolvedIntegrationEnvironment) {}

  async detect(_context: IntegrationContext) {
    return (await commandAvailable("claude", this.environment))
      ? { state: "installed" as const, evidence: "claude executable found on PATH" }
      : { state: "not_detected" as const, evidence: "claude executable not found on PATH" };
  }

  async status(options: IntegrationOptions): Promise<ConnectionStatus> {
    const configPath = claudeConfigPath(this.environment);
    try {
      const config = await readJsoncConfig(configPath);
      const servers = config.value.mcpServers;
      if (servers !== undefined && !isJsonObject(servers)) throw new Error("Claude `mcpServers` must be an object");
      const entry = isJsonObject(servers) ? servers[CODE_ATLAS_NAME] : undefined;
      const launch = claudeLaunchFromEntry(entry);
      const validation = launch ? await validateConfiguredLaunch(launch) : undefined;
      const configured = isClaudeEntry(entry) || validation === "valid";
      const stale = validation === "stale" || validation === "ephemeral";
      const warnings = stale
        ? ["The CodeAtlas MCP launcher is stale; run `code-atlas connect claude` again."]
        : !configured && entry !== undefined
        ? ["A CodeAtlas-named entry exists but does not point to `code-atlas mcp`."]
        : [];
      return statusValue(configPath, configured, warnings, stale ? "stale" : entry !== undefined && !configured ? "invalid_config" : undefined, entry !== undefined);
    } catch (error) {
      return statusValue(configPath, false, [error instanceof Error ? error.message : String(error)], "invalid_config", true);
    }
  }

  async connect(options: IntegrationOptions, launch: DurableMcpLaunch): Promise<IntegrationChange> {
    if (options.scope === "user") throw new Error("Claude Code integration supports project scope only.");
    const configPath = claudeConfigPath(this.environment);
    const current = await readJsoncConfig(configPath);
    const servers = current.value.mcpServers;
    if (servers !== undefined && !isJsonObject(servers)) throw new Error("Claude `mcpServers` must be an object");
    const existing = isJsonObject(servers) ? servers[CODE_ATLAS_NAME] : undefined;
    if (existing !== undefined && !isClaudeManagedEntry(existing)) {
      throw new Error("Refusing to replace an unrelated CodeAtlas-named Claude configuration.");
    }
    const changed = await writeJsoncValue(configPath, ["mcpServers", CODE_ATLAS_NAME], {
      command: launch.command,
      args: [...launch.args],
    });
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
    if (options.scope === "user") throw new Error("Claude Code integration supports project scope only.");
    const configPath = claudeConfigPath(this.environment);
    const current = await readJsoncConfig(configPath);
    const servers = current.value.mcpServers;
    if (servers !== undefined && !isJsonObject(servers)) throw new Error("Claude `mcpServers` must be an object");
    const entry = isJsonObject(servers) ? servers[CODE_ATLAS_NAME] : undefined;
    const changed = entry !== undefined && isClaudeManagedEntry(entry)
      ? await removeJsoncValue(configPath, ["mcpServers", CODE_ATLAS_NAME])
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

function isClaudeEntry(value: unknown): boolean {
  if (!isJsonObject(value)) return false;
  return isCodeAtlasCommand(value.command, value.args);
}

function claudeLaunchFromEntry(value: unknown): DurableMcpLaunch | undefined {
  if (!isJsonObject(value) || typeof value.command !== "string" || !Array.isArray(value.args)) return undefined;
  if (value.args.length !== 2 || !value.args.every((part): part is string => typeof part === "string")) return undefined;
  const [cliPath, mode] = value.args;
  return path.isAbsolute(value.command) && path.isAbsolute(cliPath) && mode === "mcp"
    ? { command: value.command, args: [cliPath, mode] }
    : undefined;
}

function isClaudeManagedEntry(value: unknown): boolean {
  return isClaudeEntry(value) || claudeLaunchFromEntry(value) !== undefined;
}

function statusValue(
  configPath: string,
  configured: boolean,
  warnings: string[],
  invalidState?: ConnectionStatus["state"],
  managedConfigPresent = configured,
): ConnectionStatus {
  return {
    state: invalidState ?? (configured ? "connected" : "disconnected"),
    configPath,
    scope: "project",
    managedConfigPresent,
    warnings,
  };
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
