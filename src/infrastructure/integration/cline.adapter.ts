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
import { clineConfigPath } from "./config-paths.js";
import { commandAvailable, type ResolvedIntegrationEnvironment } from "./integration-environment.js";
import { isJsonObject, readJsoncConfig, removeJsoncValue, writeJsoncValue } from "./jsonc-config.js";
import { configuredMcpLaunch, validateConfiguredLaunch } from "./mcp-launcher.js";

const displayName = "Cline";

export class ClineIntegration implements IntegrationAdapter {
  readonly descriptor = {
    id: "cline" as const,
    displayName,
    scopes: ["user"] as const,
    configFormat: "json" as const,
    supportsEnablement: true,
  };

  constructor(private readonly environment: ResolvedIntegrationEnvironment) {}

  async detect(_context: IntegrationContext) {
    return (await commandAvailable("cline", this.environment))
      ? { state: "installed" as const, evidence: "cline executable found on PATH" }
      : { state: "not_detected" as const, evidence: "cline executable not found on PATH" };
  }

  async status(options: IntegrationOptions): Promise<ConnectionStatus> {
    const configPath = this.configPath(options);
    try {
      const config = await readJsoncConfig(configPath);
      const servers = config.value.mcpServers;
      if (servers !== undefined && !isJsonObject(servers)) throw new Error("Cline `mcpServers` must be an object");
      const entry = isJsonObject(servers) ? servers[CODE_ATLAS_NAME] : undefined;
      const launch = clineLaunchFromEntry(entry);
      const validation = launch ? await validateConfiguredLaunch(launch) : undefined;
      const managed = isClineManagedEntry(entry);
      const disabled = isJsonObject(entry) && entry.disabled === true;
      const configured = managed && !disabled && (isClineLegacyEntry(entry) || validation === "valid");
      const stale = validation === "stale" || validation === "ephemeral";
      const warnings = stale
        ? ["The CodeAtlas MCP launcher is stale; run `code-atlas connect cline` again."]
        : disabled && managed
        ? ["The CodeAtlas MCP server is disabled in Cline; run `code-atlas connect cline` to enable it."]
        : !managed && entry !== undefined
        ? ["A CodeAtlas-named entry exists but does not point to `code-atlas mcp`."]
        : [];
      return statusValue(
        configPath,
        configured,
        warnings,
        stale ? "stale" : entry !== undefined && !managed ? "invalid_config" : undefined,
        managed,
      );
    } catch (error) {
      return statusValue(configPath, false, [error instanceof Error ? error.message : String(error)], "invalid_config", true);
    }
  }

  async connect(options: IntegrationOptions, launch: DurableMcpLaunch): Promise<IntegrationChange> {
    const configPath = this.configPath(options);
    const current = await readJsoncConfig(configPath);
    const servers = current.value.mcpServers;
    if (servers !== undefined && !isJsonObject(servers)) throw new Error("Cline `mcpServers` must be an object");
    const existing = isJsonObject(servers) ? servers[CODE_ATLAS_NAME] : undefined;
    if (existing !== undefined && !isClineManagedEntry(existing)) {
      throw new Error("Refusing to replace an unrelated CodeAtlas-named Cline configuration.");
    }
    const changed = await writeJsoncValue(configPath, ["mcpServers", CODE_ATLAS_NAME], {
      ...(isJsonObject(existing) ? existing : {}),
      command: launch.command,
      args: [...launch.args],
      disabled: false,
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
    if (servers !== undefined && !isJsonObject(servers)) throw new Error("Cline `mcpServers` must be an object");
    const entry = isJsonObject(servers) ? servers[CODE_ATLAS_NAME] : undefined;
    const changed = entry !== undefined && isClineManagedEntry(entry)
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
    if (options.scope !== undefined && options.scope !== "user") {
      throw new Error("Cline integration supports user scope only.");
    }
    return clineConfigPath(this.environment);
  }
}

function isClineLegacyEntry(value: unknown): boolean {
  return isJsonObject(value) && isCodeAtlasCommand(value.command, value.args);
}

function clineLaunchFromEntry(value: unknown): DurableMcpLaunch | undefined {
  if (!isJsonObject(value) || typeof value.command !== "string" || !Array.isArray(value.args)) return undefined;
  if (!value.args.every((part): part is string => typeof part === "string")) return undefined;
  return configuredMcpLaunch(value.command, value.args);
}

function isClineManagedEntry(value: unknown): boolean {
  return isClineLegacyEntry(value) || clineLaunchFromEntry(value) !== undefined;
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
