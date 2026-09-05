import path from "node:path";

import type { IntegrationScope } from "../../core/integration/integration.types.js";
import type { ResolvedIntegrationEnvironment } from "./integration-environment.js";

export function codexConfigPath(environment: ResolvedIntegrationEnvironment): string {
  const pathApi = environment.platform === "win32" ? path.win32 : path;
  return pathApi.join(
    environment.env.CODEX_HOME
      ? pathApi.resolve(environment.env.CODEX_HOME)
      : pathApi.join(environment.home, ".codex"),
    "config.toml",
  );
}

export function openCodeConfigPath(
  environment: ResolvedIntegrationEnvironment,
  scope: IntegrationScope = "user",
): string {
  const pathApi = environment.platform === "win32" ? path.win32 : path;
  if (scope === "project") {
    const jsonc = pathApi.join(environment.cwd, "opencode.jsonc");
    return jsonc;
  }

  const base = environment.platform === "win32"
    ? pathApi.join(environment.env.APPDATA ?? pathApi.join(environment.home, "AppData", "Roaming"), "opencode")
    : pathApi.join(environment.env.XDG_CONFIG_HOME ?? pathApi.join(environment.home, ".config"), "opencode");
  return pathApi.join(base, "opencode.json");
}

export function claudeConfigPath(environment: ResolvedIntegrationEnvironment): string {
  const pathApi = environment.platform === "win32" ? path.win32 : path;
  return pathApi.join(environment.cwd, ".mcp.json");
}

export function geminiConfigPath(
  environment: ResolvedIntegrationEnvironment,
  scope: IntegrationScope = "project",
): string {
  const pathApi = environment.platform === "win32" ? path.win32 : path;
  const base = scope === "project" ? environment.cwd : environment.home;
  return pathApi.join(base, ".gemini", "settings.json");
}

export function cursorConfigPath(
  environment: ResolvedIntegrationEnvironment,
  scope: IntegrationScope = "project",
): string {
  const pathApi = environment.platform === "win32" ? path.win32 : path;
  const base = scope === "project" ? environment.cwd : environment.home;
  return pathApi.join(base, ".cursor", "mcp.json");
}

export function clineConfigPath(environment: ResolvedIntegrationEnvironment): string {
  const pathApi = environment.platform === "win32" ? path.win32 : path;
  return pathApi.join(environment.home, ".cline", "mcp.json");
}

export function windsurfConfigPath(
  environment: ResolvedIntegrationEnvironment,
  scope: IntegrationScope = "user",
): string {
  if (scope !== "user") throw new Error("Windsurf integration supports user scope only.");
  const pathApi = environment.platform === "win32" ? path.win32 : path;
  return pathApi.join(environment.home, ".codeium", "windsurf", "mcp_config.json");
}

export function zooConfigPath(
  environment: ResolvedIntegrationEnvironment,
  scope: IntegrationScope = "project",
): string {
  if (scope !== "project") throw new Error("Zoo Code integration supports project scope only.");
  const pathApi = environment.platform === "win32" ? path.win32 : path;
  return pathApi.join(environment.cwd, ".roo", "mcp.json");
}
