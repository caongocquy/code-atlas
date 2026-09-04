import { AgentIntegrationService } from "../../core/integration/agent-integration.service.js";
import { IntegrationRegistry } from "../../core/integration/integration-registry.js";
import { ClaudeIntegration } from "./claude.adapter.js";
import { CodexIntegration } from "./codex.adapter.js";
import { resolveIntegrationEnvironment, type IntegrationEnvironment } from "./integration-environment.js";
import { OpenCodeIntegration } from "./opencode.adapter.js";
import { resolveDurableMcpLaunch } from "./mcp-launcher.js";
import { installGuidance, strictGuidanceStatus, uninstallStrictGuidance } from "./strict-guidance.js";

export function createAgentIntegrationService(
  environmentInput: IntegrationEnvironment = {},
): AgentIntegrationService {
  return new AgentIntegrationService(createIntegrationRegistry(environmentInput), {
    status: strictGuidanceStatus,
    install: (repoPath, strict) => installGuidance(repoPath, strict),
    uninstall: uninstallStrictGuidance,
  }, resolveDurableMcpLaunch);
}

export function createIntegrationRegistry(
  environmentInput: IntegrationEnvironment = {},
): IntegrationRegistry {
  const environment = resolveIntegrationEnvironment(environmentInput);
  return new IntegrationRegistry([
    new CodexIntegration(environment),
    new OpenCodeIntegration(environment),
    new ClaudeIntegration(environment),
  ]);
}
