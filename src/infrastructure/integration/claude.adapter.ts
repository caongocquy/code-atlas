import fs from "node:fs/promises";

import type {
  AgentIntegration,
  IntegrationChange,
  IntegrationOptions,
  IntegrationStatus,
} from "../../core/integration/integration.types.js";
import { CODE_ATLAS_ARGS, CODE_ATLAS_COMMAND, CODE_ATLAS_NAME, isCodeAtlasCommand } from "./agent-entry.js";
import { claudeConfigPath } from "./config-paths.js";
import { isJsonObject, readJsoncConfig, removeJsoncValue, writeJsoncValue } from "./jsonc-config.js";
import { commandAvailable, type ResolvedIntegrationEnvironment } from "./integration-environment.js";

const displayName = "Claude Code";

export class ClaudeIntegration implements AgentIntegration {
  readonly id = "claude" as const;
  readonly displayName = displayName;

  constructor(private readonly environment: ResolvedIntegrationEnvironment) {}

  async status(options: IntegrationOptions) {
    const configPath = claudeConfigPath(this.environment);
    const detected = await commandAvailable("claude", this.environment);
    try {
      const config = await readJsoncConfig(configPath);
      const servers = config.value.mcpServers;
      if (servers !== undefined && !isJsonObject(servers)) throw new Error("Claude `mcpServers` must be an object");
      const entry = isJsonObject(servers) ? servers[CODE_ATLAS_NAME] : undefined;
      const configured = isClaudeEntry(entry);
      const warnings = !configured && entry !== undefined
        ? ["A CodeAtlas-named entry exists but does not point to `code-atlas mcp`."]
        : [];
      return statusValue(detected || config.file.exists, configPath, configured, true, warnings);
    } catch (error) {
      return statusValue(detected || await exists(configPath), configPath, false, false, [error instanceof Error ? error.message : String(error)], "invalid_config");
    }
  }

  async install(options: IntegrationOptions): Promise<IntegrationChange> {
    if (options.scope === "user") throw new Error("Claude Code integration supports project scope only.");
    const configPath = claudeConfigPath(this.environment);
    const changed = await writeJsoncValue(configPath, ["mcpServers", CODE_ATLAS_NAME], {
      command: CODE_ATLAS_COMMAND,
      args: [...CODE_ATLAS_ARGS],
    });
    return {
      id: this.id,
      displayName: this.displayName,
      operation: "install",
      changed,
      status: await this.status(options),
      strictGuidanceChanged: false,
    };
  }

  async uninstall(options: IntegrationOptions): Promise<IntegrationChange> {
    if (options.scope === "user") throw new Error("Claude Code integration supports project scope only.");
    const configPath = claudeConfigPath(this.environment);
    const changed = await removeJsoncValue(configPath, ["mcpServers", CODE_ATLAS_NAME]);
    return {
      id: this.id,
      displayName: this.displayName,
      operation: "uninstall",
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

function statusValue(
  detected: boolean,
  configPath: string,
  configured: boolean,
  valid: boolean,
  warnings: string[],
  invalidState?: IntegrationStatus["state"],
): IntegrationStatus {
  return {
    id: "claude",
    displayName,
    state: invalidState ?? (configured ? "installed" : detected ? "not_installed" : "unavailable"),
    detected,
    configPath,
    scope: "project",
    codeAtlasMcpConfigured: configured,
    configurationValid: valid,
    command: CODE_ATLAS_COMMAND,
    args: [...CODE_ATLAS_ARGS],
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
