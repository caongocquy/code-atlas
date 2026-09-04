import { AgentIntegrationService } from "../../core/integration/agent-integration.service.js";
import type { AgentId } from "../../core/integration/integration.types.js";
import { ClaudeIntegration } from "./claude.adapter.js";
import { CodexIntegration } from "./codex.adapter.js";
import { resolveIntegrationEnvironment, type IntegrationEnvironment } from "./integration-environment.js";
import { OpenCodeIntegration } from "./opencode.adapter.js";
import { installGuidance, strictGuidanceStatus, uninstallStrictGuidance } from "./strict-guidance.js";

export function createAgentIntegrationService(
  environmentInput: IntegrationEnvironment = {},
): AgentIntegrationService {
  const environment = resolveIntegrationEnvironment(environmentInput);
  return new AgentIntegrationService([
    new CodexIntegration(environment),
    new OpenCodeIntegration(environment),
    new ClaudeIntegration(environment),
  ], {
    status: strictGuidanceStatus,
    install: (repoPath, strict) => installGuidance(repoPath, strict),
    uninstall: uninstallStrictGuidance,
  });
}

export const supportedAgentIds: AgentId[] = ["codex", "opencode", "claude"];
