import { stat } from "node:fs/promises";
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
import { CODE_ATLAS_NAME, isCodeAtlasCommand } from "./agent-entry.js";
import { cursorConfigPath } from "./config-paths.js";
import { commandAvailable, type ResolvedIntegrationEnvironment } from "./integration-environment.js";
import { isJsonObject, readJsoncConfig, removeJsoncValue, writeJsoncValue } from "./jsonc-config.js";
import { configuredMcpLaunch, validateConfiguredLaunch } from "./mcp-launcher.js";

const displayName = "Cursor";

export class CursorIntegration implements IntegrationAdapter {
  readonly descriptor = {
    id: "cursor" as const,
    displayName,
    scopes: ["user", "project"] as const,
    configFormat: "json" as const,
    supportsEnablement: false,
  };

  constructor(private readonly environment: ResolvedIntegrationEnvironment) {}

  async detect(_context: IntegrationContext) {
    if (await commandAvailable("cursor-agent", this.environment)) {
      return { state: "installed" as const, evidence: "cursor-agent executable found on PATH" };
    }
    if (await commandAvailable("cursor", this.environment)) {
      return { state: "installed" as const, evidence: "cursor executable found on PATH" };
    }
    if (this.environment.platform === "darwin") {
      for (const appPath of [
        path.join(this.environment.home, "Applications", "Cursor.app"),
        "/Applications/Cursor.app",
      ]) {
        if (await exists(appPath)) return { state: "installed" as const, evidence: `Cursor app found at ${appPath}` };
      }
    }
    return { state: "not_detected" as const, evidence: "Cursor application or cursor-agent executable not detected" };
  }

  async status(options: IntegrationOptions): Promise<ConnectionStatus> {
    const scope = options.scope ?? "project";
    const configPath = cursorConfigPath(this.environment, scope);
    try {
      const config = await readJsoncConfig(configPath);
      const servers = config.value.mcpServers;
      if (servers !== undefined && !isJsonObject(servers)) throw new Error("Cursor `mcpServers` must be an object");
      const entry = isJsonObject(servers) ? servers[CODE_ATLAS_NAME] : undefined;
      const launch = cursorLaunchFromEntry(entry);
      const validation = launch ? await validateConfiguredLaunch(launch) : undefined;
      const configured = isCursorLegacyEntry(entry) || validation === "valid";
      const stale = validation === "stale" || validation === "ephemeral";
      const warnings = stale
        ? ["The CodeAtlas MCP launcher is stale; run `code-atlas connect cursor` again."]
        : !configured && entry !== undefined
        ? ["A CodeAtlas-named entry exists but does not point to `code-atlas mcp`."]
        : [];
      return statusValue(
        scope,
        configPath,
        configured,
        warnings,
        stale ? "stale" : entry !== undefined && !configured ? "invalid_config" : undefined,
        entry !== undefined,
      );
    } catch (error) {
      return statusValue(scope, configPath, false, [error instanceof Error ? error.message : String(error)], "invalid_config", true);
    }
  }

  async connect(options: IntegrationOptions, launch: DurableMcpLaunch): Promise<IntegrationChange> {
    const scope = options.scope ?? "project";
    const configPath = cursorConfigPath(this.environment, scope);
    const current = await readJsoncConfig(configPath);
    const servers = current.value.mcpServers;
    if (servers !== undefined && !isJsonObject(servers)) throw new Error("Cursor `mcpServers` must be an object");
    const existing = isJsonObject(servers) ? servers[CODE_ATLAS_NAME] : undefined;
    if (existing !== undefined && !isCursorManagedEntry(existing)) {
      throw new Error("Refusing to replace an unrelated CodeAtlas-named Cursor configuration.");
    }
    const changed = await writeJsoncValue(configPath, ["mcpServers", CODE_ATLAS_NAME], {
      type: "stdio",
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
    const scope = options.scope ?? "project";
    const configPath = cursorConfigPath(this.environment, scope);
    const current = await readJsoncConfig(configPath);
    const servers = current.value.mcpServers;
    if (servers !== undefined && !isJsonObject(servers)) throw new Error("Cursor `mcpServers` must be an object");
    const entry = isJsonObject(servers) ? servers[CODE_ATLAS_NAME] : undefined;
    const changed = entry !== undefined && isCursorManagedEntry(entry)
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

function isCursorLegacyEntry(value: unknown): boolean {
  return isJsonObject(value) && isCodeAtlasCommand(value.command, value.args);
}

function cursorLaunchFromEntry(value: unknown): DurableMcpLaunch | undefined {
  if (!isJsonObject(value) || value.type !== "stdio" || typeof value.command !== "string" || !Array.isArray(value.args)) return undefined;
  if (!value.args.every((part): part is string => typeof part === "string")) return undefined;
  return configuredMcpLaunch(value.command, value.args);
}

function isCursorManagedEntry(value: unknown): boolean {
  return isCursorLegacyEntry(value) || cursorLaunchFromEntry(value) !== undefined;
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}
