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
import { windsurfConfigPath } from "./config-paths.js";
import { commandAvailable, type ResolvedIntegrationEnvironment } from "./integration-environment.js";
import { isJsonObject, readJsoncConfig, removeJsoncValue, writeJsoncValue } from "./jsonc-config.js";
import { configuredMcpLaunch, validateConfiguredLaunch } from "./mcp-launcher.js";

const displayName = "Windsurf";

export class WindsurfIntegration implements IntegrationAdapter {
  readonly descriptor = {
    id: "windsurf" as const,
    displayName,
    scopes: ["user"] as const,
    configFormat: "json" as const,
    supportsEnablement: false,
  };

  constructor(private readonly environment: ResolvedIntegrationEnvironment) {}

  async detect(_context: IntegrationContext) {
    if (await commandAvailable("windsurf", this.environment)) {
      return { state: "installed" as const, evidence: "windsurf executable found on PATH" };
    }
    if (this.environment.platform === "darwin") {
      for (const appPath of [
        path.join(this.environment.home, "Applications", "Windsurf.app"),
        "/Applications/Windsurf.app",
      ]) {
        if (await exists(appPath)) return { state: "installed" as const, evidence: `Windsurf app found at ${appPath}` };
      }
    }
    return { state: "not_detected" as const, evidence: "Windsurf application or executable not detected" };
  }

  async status(options: IntegrationOptions): Promise<ConnectionStatus> {
    const configPath = this.configPath(options);
    try {
      const config = await readJsoncConfig(configPath);
      const servers = config.value.mcpServers;
      if (servers !== undefined && !isJsonObject(servers)) throw new Error("Windsurf `mcpServers` must be an object");
      const entry = isJsonObject(servers) ? servers[CODE_ATLAS_NAME] : undefined;
      const launch = windsurfLaunchFromEntry(entry);
      const validation = launch ? await validateConfiguredLaunch(launch) : undefined;
      const configured = isWindsurfLegacyEntry(entry) || validation === "valid";
      const stale = validation === "stale" || validation === "ephemeral";
      const warnings = stale
        ? ["The CodeAtlas MCP launcher is stale; run `code-atlas connect windsurf` again."]
        : !configured && entry !== undefined
        ? ["A CodeAtlas-named entry exists but does not point to `code-atlas mcp`."]
        : [];
      return statusValue(
        configPath,
        configured,
        warnings,
        stale ? "stale" : entry !== undefined && !configured ? "invalid_config" : undefined,
        entry !== undefined,
      );
    } catch (error) {
      return statusValue(configPath, false, [error instanceof Error ? error.message : String(error)], "invalid_config", true);
    }
  }

  async connect(options: IntegrationOptions, launch: DurableMcpLaunch): Promise<IntegrationChange> {
    const configPath = this.configPath(options);
    const current = await readJsoncConfig(configPath);
    const servers = current.value.mcpServers;
    if (servers !== undefined && !isJsonObject(servers)) throw new Error("Windsurf `mcpServers` must be an object");
    const existing = isJsonObject(servers) ? servers[CODE_ATLAS_NAME] : undefined;
    if (existing !== undefined && !isWindsurfManagedEntry(existing)) {
      throw new Error("Refusing to replace an unrelated CodeAtlas-named Windsurf configuration.");
    }
    const changed = await writeJsoncValue(configPath, ["mcpServers", CODE_ATLAS_NAME], {
      ...(isJsonObject(existing) ? existing : {}),
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
    const configPath = this.configPath(options);
    const current = await readJsoncConfig(configPath);
    const servers = current.value.mcpServers;
    if (servers !== undefined && !isJsonObject(servers)) throw new Error("Windsurf `mcpServers` must be an object");
    const entry = isJsonObject(servers) ? servers[CODE_ATLAS_NAME] : undefined;
    const changed = entry !== undefined && isWindsurfManagedEntry(entry)
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

  private configPath(options: IntegrationOptions): string {
    return windsurfConfigPath(this.environment, options.scope ?? "user");
  }
}

function isWindsurfLegacyEntry(value: unknown): boolean {
  return isJsonObject(value) && isCodeAtlasCommand(value.command, value.args);
}

function windsurfLaunchFromEntry(value: unknown): DurableMcpLaunch | undefined {
  if (!isJsonObject(value) || typeof value.command !== "string" || !Array.isArray(value.args)) return undefined;
  if (!value.args.every((part): part is string => typeof part === "string")) return undefined;
  return configuredMcpLaunch(value.command, value.args);
}

function isWindsurfManagedEntry(value: unknown): boolean {
  return isWindsurfLegacyEntry(value) || windsurfLaunchFromEntry(value) !== undefined;
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
    scope: "user",
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
