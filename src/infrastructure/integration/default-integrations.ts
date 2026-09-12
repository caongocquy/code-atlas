import { AgentIntegrationService } from "../../core/integration/agent-integration.service.js";
import { IntegrationRegistry } from "../../core/integration/integration-registry.js";
import type { ResolveDurableMcpLaunch } from "../../core/integration/integration.types.js";
import { ClaudeIntegration } from "./claude.adapter.js";
import { ClineIntegration } from "./cline.adapter.js";
import { CodexIntegration } from "./codex.adapter.js";
import { CursorIntegration } from "./cursor.adapter.js";
import { GeminiIntegration } from "./gemini.adapter.js";
import { resolveIntegrationEnvironment, type IntegrationEnvironment } from "./integration-environment.js";
import { OpenCodeIntegration } from "./opencode.adapter.js";
import { resolveDurableMcpLaunch } from "./mcp-launcher.js";
import { installGuidance, strictGuidanceStatus, uninstallStrictGuidance } from "./strict-guidance.js";
import { WindsurfIntegration } from "./windsurf.adapter.js";
import { ZooIntegration } from "./zoo.adapter.js";

export function createAgentIntegrationService(
  environmentInput: IntegrationEnvironment = {},
  resolveLaunch: ResolveDurableMcpLaunch = resolveDurableMcpLaunch,
): AgentIntegrationService {
  return new AgentIntegrationService(createIntegrationRegistry(environmentInput), {
    status: strictGuidanceStatus,
    install: (repoPath, strict) => installGuidance(repoPath, strict),
    uninstall: uninstallStrictGuidance,
  }, resolveLaunch);
}

export function createIntegrationRegistry(
  environmentInput: IntegrationEnvironment = {},
): IntegrationRegistry {
  const environment = resolveIntegrationEnvironment(environmentInput);
  return new IntegrationRegistry([
    new CodexIntegration(environment),
    new OpenCodeIntegration(environment),
    new ClaudeIntegration(environment),
    new GeminiIntegration(environment),
    new CursorIntegration(environment),
    new ClineIntegration(environment),
    new WindsurfIntegration(environment),
    new ZooIntegration(environment),
  ]);
}
