import path from "node:path";

import type { AgentId, IntegrationScope } from "../../core/integration/integration.types.js";
import { createAgentIntegrationService, supportedAgentIds } from "../../infrastructure/integration/default-integrations.js";

export async function runIntegrationCommand(args: string[], repoPath = path.resolve(".")): Promise<void> {
  const service = createAgentIntegrationService({ cwd: repoPath });
  const [action, requestedId] = args.filter((arg) => !arg.startsWith("--"));
  const scope = readScope(args);
  const strict = args.includes("--strict");
  const options = { repoPath, ...(scope ? { scope } : {}), strict };

  if (!action || action === "list" || action === "status") {
    const statuses = requestedId
      ? [await service.status(assertAgentId(requestedId), options)]
      : await service.list(options);
    print({ action: action ?? "list", integrations: statuses });
    return;
  }

  if (action !== "install" && action !== "uninstall") {
    throw new Error("Usage: code-atlas integration list|status|install|uninstall <codex|opencode|claude> [--scope user|project] [--strict]");
  }

  if (args.includes("--all")) {
    if (action === "uninstall") throw new Error("`--all` is supported for install only.");
    const statuses = await service.list(options);
    const results = [];
    const skipped = [];
    for (const status of statuses) {
      if (status.detected && status.state !== "invalid_config") {
        results.push(await service.install(status.id, options));
      } else {
        skipped.push({ id: status.id, reason: status.state });
      }
    }
    print({ action, results, skipped });
    return;
  }

  if (!requestedId) throw new Error("An integration id is required.");
  const id = assertAgentId(requestedId);
  print({ action, result: await service[action](id, options) });
}

function readScope(args: string[]): IntegrationScope | undefined {
  const index = args.indexOf("--scope");
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value !== "user" && value !== "project") throw new Error("Scope must be `user` or `project`.");
  return value;
}

function assertAgentId(value: string): AgentId {
  if ((supportedAgentIds as string[]).includes(value)) return value as AgentId;
  throw new Error(`Unsupported agent integration: ${value}`);
}

function print(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}
