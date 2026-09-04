import path from "node:path";

import { initializeRepository } from "../../core/repository/repository-init.service.js";
import type { AgentId } from "../../core/integration/integration.types.js";
import { createAgentIntegrationService, supportedAgentIds } from "../../infrastructure/integration/default-integrations.js";

export async function runInitCommand(args: string[], repoPath = path.resolve(".")): Promise<void> {
  const agent = agentValue(args);
  const optionValues = new Set([agent, "user", "project"]);
  const explicitPath = args.find((arg, index) => {
    if (arg.startsWith("--") || optionValues.has(arg)) return false;
    if (args[index - 1] === "--agent" || args[index - 1] === "--scope") return false;
    return true;
  });
  const targetPath = explicitPath ? path.resolve(repoPath, explicitPath) : repoPath;
  const result = await initializeRepository(targetPath);
  const integrations = [];

  if (agent) {
    const service = createAgentIntegrationService({ cwd: targetPath });
    const ids = agent === "all" ? supportedAgentIds : [agent as AgentId];
    for (const id of ids) {
      const options = { repoPath: targetPath, strict: args.includes("--strict") };
      const status = await service.status(id, options);
      if (agent === "all" && (status.state === "unavailable" || status.state === "invalid_config")) continue;
      integrations.push(await service.install(id, options));
    }
  }

  process.stdout.write(`${JSON.stringify({ ...result, integrations }, null, 2)}\n`);
}

function agentValue(args: string[]): string | undefined {
  const index = args.indexOf("--agent");
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value || (value !== "all" && !(supportedAgentIds as string[]).includes(value))) {
    throw new Error("Agent must be codex, opencode, claude, or all.");
  }
  return value;
}
