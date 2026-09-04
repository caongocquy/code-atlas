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
