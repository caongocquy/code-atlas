import fs from "node:fs/promises";
import path from "node:path";

import type {
  AgentIntegration,
  IntegrationChange,
  IntegrationOptions,
  IntegrationScope,
  IntegrationStatus,
} from "../../core/integration/integration.types.js";
import { CODE_ATLAS_ARGS, CODE_ATLAS_COMMAND, CODE_ATLAS_NAME, isCodeAtlasCommand } from "./agent-entry.js";
import { openCodeConfigPath } from "./config-paths.js";
import { isJsonObject, readJsoncConfig, removeJsoncValue, writeJsoncValue } from "./jsonc-config.js";
import { commandAvailable, type ResolvedIntegrationEnvironment } from "./integration-environment.js";

const displayName = "OpenCode";

export class OpenCodeIntegration implements AgentIntegration {
  readonly id = "opencode" as const;
  readonly displayName = displayName;

  constructor(private readonly environment: ResolvedIntegrationEnvironment) {}

  async status(options: IntegrationOptions): Promise<IntegrationStatus> {
    const scope = options.scope ?? "user";
    const configPath = await existingPath(this.environment, scope);
    const detected = await commandAvailable("opencode", this.environment);
    try {
      const config = await readJsoncConfig(configPath);
      const serverPath = mcpServerPath(config.value);
      const entry = serverPath ? valueAt(config.value, [...serverPath, CODE_ATLAS_NAME]) : undefined;
      const configured = isOpenCodeEntry(entry);
      const warnings = !configured && entry !== undefined
        ? ["A CodeAtlas-named entry exists but does not point to `code-atlas mcp`."]
        : [];
      return statusValue(scope, detected || config.file.exists, configPath, configured, true, warnings);
    } catch (error) {
      return statusValue(scope, detected || await exists(configPath), configPath, false, false, [error instanceof Error ? error.message : String(error)], "invalid_config");
    }
  }

  async install(options: IntegrationOptions): Promise<IntegrationChange> {
    const scope = options.scope ?? "user";
    const configPath = await existingPath(this.environment, scope);
    const current = await readJsoncConfig(configPath);
    const serverPath = mcpServerPath(current.value) ?? ["mcp"];
    const nested = serverPath.at(-1) === "servers";
    const changed = await writeJsoncValue(
      configPath,
      [...serverPath, CODE_ATLAS_NAME],
      nested
        ? { type: "local", command: [CODE_ATLAS_COMMAND, ...CODE_ATLAS_ARGS] }
        : { type: "local", command: [CODE_ATLAS_COMMAND, ...CODE_ATLAS_ARGS], enabled: true },
    );
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
    const scope = options.scope ?? "user";
    const configPath = await existingPath(this.environment, scope);
    const current = await readJsoncConfig(configPath);
    const serverPath = mcpServerPath(current.value);
    const changed = serverPath
      ? await removeJsoncValue(configPath, [...serverPath, CODE_ATLAS_NAME])
      : false;
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
  if (!isJsonObject(value) || value.type !== "local") return false;
  return isCodeAtlasCommand(
    Array.isArray(value.command) ? value.command[0] : undefined,
    Array.isArray(value.command) ? value.command.slice(1) : undefined,
  ) && value.disabled !== true && value.enabled !== false;
}

function statusValue(
  scope: IntegrationScope,
  detected: boolean,
  configPath: string,
  configured: boolean,
  valid: boolean,
  warnings: string[],
  invalidState?: IntegrationStatus["state"],
): IntegrationStatus {
  return {
    id: "opencode",
    displayName,
    state: invalidState ?? (configured ? "installed" : detected ? "not_installed" : "unavailable"),
    detected,
    configPath,
    scope,
    codeAtlasMcpConfigured: configured,
    configurationValid: valid,
    command: CODE_ATLAS_COMMAND,
    args: [...CODE_ATLAS_ARGS],
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
