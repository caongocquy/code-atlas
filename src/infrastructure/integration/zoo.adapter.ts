import { execFile as execFileCallback } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

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
import { zooConfigPath } from "./config-paths.js";
import { commandAvailable, type ResolvedIntegrationEnvironment } from "./integration-environment.js";
import { isJsonObject, readJsoncConfig, removeJsoncValue, writeJsoncValue } from "./jsonc-config.js";
import { validateConfiguredLaunch } from "./mcp-launcher.js";

const execFile = promisify(execFileCallback);
const ZOO_EXTENSION_ID = "zoocodeorganization.zoo-code";
const displayName = "Zoo Code";

export type ZooDetection = {
  listExtensions?: () => Promise<readonly string[]>;
};

export class ZooIntegration implements IntegrationAdapter {
  readonly descriptor = {
    id: "zoo" as const,
    displayName,
    scopes: ["project"] as const,
    configFormat: "json" as const,
    supportsEnablement: true,
  };

  private readonly listExtensions: () => Promise<readonly string[]>;

  constructor(
    private readonly environment: ResolvedIntegrationEnvironment,
    detection: ZooDetection = {},
  ) {
    this.listExtensions = detection.listExtensions ?? (() => listEditorExtensions(this.environment));
  }

  async detect(_context: IntegrationContext) {
    try {
      const extensions = await this.listExtensions();
      return extensions.some((extension) => extension.toLowerCase() === ZOO_EXTENSION_ID)
        ? { state: "installed" as const, evidence: `Zoo Code extension ${ZOO_EXTENSION_ID} found` }
        : { state: "not_detected" as const, evidence: "Zoo Code extension not detected" };
    } catch {
      return { state: "not_detected" as const, evidence: "Zoo Code extension not detected" };
    }
  }

  async status(options: IntegrationOptions): Promise<ConnectionStatus> {
    const configPath = this.configPath(options);
    try {
      const config = await readJsoncConfig(configPath);
      const servers = config.value.mcpServers;
      if (servers !== undefined && !isJsonObject(servers)) throw new Error("Zoo Code `mcpServers` must be an object");
      const entry = isJsonObject(servers) ? servers[CODE_ATLAS_NAME] : undefined;
      const launch = zooLaunchFromEntry(entry);
      const validation = launch ? await validateConfiguredLaunch(launch) : undefined;
      const managed = isZooManagedEntry(entry);
      const disabled = isJsonObject(entry) && entry.disabled === true;
      const configured = managed && !disabled && (isZooLegacyEntry(entry) || validation === "valid");
      const stale = validation === "stale" || validation === "ephemeral";
      const warnings = stale
        ? ["The CodeAtlas MCP launcher is stale; run `code-atlas connect zoo` again."]
        : disabled && managed
        ? ["The CodeAtlas MCP server is disabled in Zoo Code; run `code-atlas connect zoo` to enable it."]
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
    if (servers !== undefined && !isJsonObject(servers)) throw new Error("Zoo Code `mcpServers` must be an object");
    const existing = isJsonObject(servers) ? servers[CODE_ATLAS_NAME] : undefined;
    if (existing !== undefined && !isZooManagedEntry(existing)) {
      throw new Error("Refusing to replace an unrelated CodeAtlas-named Zoo Code configuration.");
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
    if (servers !== undefined && !isJsonObject(servers)) throw new Error("Zoo Code `mcpServers` must be an object");
    const entry = isJsonObject(servers) ? servers[CODE_ATLAS_NAME] : undefined;
    const changed = entry !== undefined && isZooManagedEntry(entry)
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
    return zooConfigPath(this.environment, options.scope ?? "project");
  }
}

function isZooLegacyEntry(value: unknown): boolean {
  return isJsonObject(value) && isCodeAtlasCommand(value.command, value.args);
}

function zooLaunchFromEntry(value: unknown): DurableMcpLaunch | undefined {
  if (!isJsonObject(value) || typeof value.command !== "string" || !Array.isArray(value.args)) return undefined;
  if (value.args.length !== 2 || !value.args.every((part): part is string => typeof part === "string")) return undefined;
  const [cliPath, mode] = value.args;
  return path.isAbsolute(value.command) && path.isAbsolute(cliPath) && mode === "mcp"
    ? { command: value.command, args: [cliPath, mode] }
    : undefined;
}

function isZooManagedEntry(value: unknown): boolean {
  return isZooLegacyEntry(value) || zooLaunchFromEntry(value) !== undefined;
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

async function listEditorExtensions(environment: ResolvedIntegrationEnvironment): Promise<readonly string[]> {
  if (!(await commandAvailable("code", environment))) return [];
  const result = await execFile("code", ["--list-extensions"], {
    env: environment.env,
    timeout: 2_000,
  });
  return result.stdout.split(/\r?\n/).map((extension) => extension.trim()).filter(Boolean);
}
