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
      const configured = isCodexEntry(entry);
      const warnings = !configured && entry !== undefined
        ? ["A CodeAtlas-named entry exists but does not point to `code-atlas mcp`."]
        : [];
      return statusValue(this.id, detected || config.file.exists, configPath, configured, true, warnings);
    } catch (error) {
      return statusValue(this.id, detected || await exists(configPath), configPath, false, false, [error instanceof Error ? error.message : String(error)], "invalid_config");
    }
  }

  async install(options: IntegrationOptions): Promise<IntegrationChange> {
    assertUserScope(options);
    const configPath = codexConfigPath(this.environment);
    const changed = await writeTomlValue(configPath, CODE_ATLAS_NAME, {
      command: CODE_ATLAS_COMMAND,
      args: CODE_ATLAS_ARGS,
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

function isCodexEntry(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const entry = value as Record<string, unknown>;
  return isCodeAtlasCommand(entry.command, entry.args) && entry.enabled !== false;
}

function statusValue(
  id: "codex",
  detected: boolean,
  configPath: string,
  configured: boolean,
  valid: boolean,
  warnings: string[],
  invalidState?: IntegrationStatus["state"],
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
    command: CODE_ATLAS_COMMAND,
    args: [...CODE_ATLAS_ARGS],
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
