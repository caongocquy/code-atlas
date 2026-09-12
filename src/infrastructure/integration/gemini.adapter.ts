
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
import { geminiConfigPath } from "./config-paths.js";
import { commandAvailable, type ResolvedIntegrationEnvironment } from "./integration-environment.js";
import { isJsonObject, readJsoncConfig, removeJsoncValue, writeJsoncValue } from "./jsonc-config.js";
import { configuredMcpLaunch, validateConfiguredLaunch } from "./mcp-launcher.js";

const displayName = "Gemini CLI";

export class GeminiIntegration implements IntegrationAdapter {
  readonly descriptor = {
    id: "gemini" as const,
    displayName,
    scopes: ["user", "project"] as const,
    configFormat: "json" as const,
    // Gemini stores enablement in a separate CLI-managed global file. Batch 1
    // deliberately manages only settings.json, so the descriptor stays truthful.
    supportsEnablement: false,
  };

  constructor(private readonly environment: ResolvedIntegrationEnvironment) {}

  async detect(_context: IntegrationContext) {
    return (await commandAvailable("gemini", this.environment))
      ? { state: "installed" as const, evidence: "gemini executable found on PATH" }
      : { state: "not_detected" as const, evidence: "gemini executable not found on PATH" };
  }

  async status(options: IntegrationOptions): Promise<ConnectionStatus> {
    const scope = options.scope ?? "project";
    const configPath = geminiConfigPath(this.environment, scope);
    try {
      const config = await readJsoncConfig(configPath);
      const servers = config.value.mcpServers;
      if (servers !== undefined && !isJsonObject(servers)) throw new Error("Gemini `mcpServers` must be an object");
      const entry = isJsonObject(servers) ? servers[CODE_ATLAS_NAME] : undefined;
      const launch = geminiLaunchFromEntry(entry);
      const validation = launch ? await validateConfiguredLaunch(launch) : undefined;
      const configured = isGeminiLegacyEntry(entry) || validation === "valid";
      const stale = validation === "stale" || validation === "ephemeral";
      const warnings = stale
        ? ["The CodeAtlas MCP launcher is stale; run `code-atlas connect gemini` again."]
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
    const configPath = geminiConfigPath(this.environment, scope);
    const current = await readJsoncConfig(configPath);
    const servers = current.value.mcpServers;
    if (servers !== undefined && !isJsonObject(servers)) throw new Error("Gemini `mcpServers` must be an object");
    const existing = isJsonObject(servers) ? servers[CODE_ATLAS_NAME] : undefined;
    if (existing !== undefined && !isGeminiManagedEntry(existing)) {
      throw new Error("Refusing to replace an unrelated CodeAtlas-named Gemini configuration.");
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
    const scope = options.scope ?? "project";
    const configPath = geminiConfigPath(this.environment, scope);
    const current = await readJsoncConfig(configPath);
    const servers = current.value.mcpServers;
    if (servers !== undefined && !isJsonObject(servers)) throw new Error("Gemini `mcpServers` must be an object");
    const entry = isJsonObject(servers) ? servers[CODE_ATLAS_NAME] : undefined;
    const changed = entry !== undefined && isGeminiManagedEntry(entry)
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

function isGeminiLegacyEntry(value: unknown): boolean {
  return isJsonObject(value) && isCodeAtlasCommand(value.command, value.args);
}

function geminiLaunchFromEntry(value: unknown): DurableMcpLaunch | undefined {
  if (!isJsonObject(value) || typeof value.command !== "string" || !Array.isArray(value.args)) return undefined;
  if (!value.args.every((part): part is string => typeof part === "string")) return undefined;
  return configuredMcpLaunch(value.command, value.args);
}

function isGeminiManagedEntry(value: unknown): boolean {
  return isGeminiLegacyEntry(value) || geminiLaunchFromEntry(value) !== undefined;
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
