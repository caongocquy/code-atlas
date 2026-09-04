import path from "node:path";

import { createCliCommandReporter } from "./cli-command-reporter.js";
import { formatIntegrationChange, formatIntegrationStatuses } from "./cli-output.js";
import type { AgentId, IntegrationScope } from "../../core/integration/integration.types.js";
import { createAgentIntegrationService, supportedAgentIds } from "../../infrastructure/integration/default-integrations.js";

export async function runIntegrationCommand(args: string[], repoPath = path.resolve(".")): Promise<void> {
  const reporter = createCliCommandReporter({ json: args.includes("--json") });
  const service = createAgentIntegrationService({ cwd: repoPath });
  const json = args.includes("--json");
  const noGuidance = args.includes("--no-guidance");
  let [action, requestedId] = args.filter((arg) => !arg.startsWith("--"));
  if (action === "integrations") action = "list";
  if (action === "connect") action = "install";
  if (action === "disconnect") action = "uninstall";
  const scope = readScope(args);
  const strict = args.includes("--strict");
  const options = { repoPath, ...(scope ? { scope } : {}), strict, noGuidance };

  if (!action || action === "list" || action === "status") {
    const statuses = requestedId
      ? [await service.status(assertAgentId(requestedId), options)]
      : await service.list(options);
    if (json) reporter.output({ action: action ?? "list", integrations: statuses });
    else reporter.success(formatIntegrationStatuses(statuses));
    return;
  }

  if (action !== "install" && action !== "uninstall") {
    throw new Error("Usage: code-atlas integration list|status|install|uninstall <codex|opencode|claude> [--scope user|project] [--strict]");
  }

  if (args.includes("--all")) {
    if (action === "uninstall") throw new Error("`--all` is supported for install only.");
    reporter.start("Connecting CodeAtlas to available agents...");
    const statuses = await service.list(options);
    const results = [];
    const skipped = [];
    for (const status of statuses) {
      if (status.detected && status.state !== "invalid_config" && status.state !== "stale") {
        results.push(await reporter.run(`Connecting CodeAtlas to ${status.displayName}`, () => service.install(status.id, options)));
      } else {
        skipped.push({ id: status.id, reason: status.state });
      }
    }
    if (json) reporter.output({ action, results, skipped });
    else {
      for (const result of results) reporter.success(`${formatIntegrationChange(result)}\n`);
      if (skipped.length > 0) reporter.warning(`Skipped: ${skipped.map((item) => `${item.id} (${item.reason})`).join(", ")}`);
    }
    return;
  }

  if (!requestedId) throw new Error("An integration id is required.");
  const id = assertAgentId(requestedId);
  reporter.start(action === "install" ? `Connecting CodeAtlas to ${id}...` : `Disconnecting CodeAtlas from ${id}...`);
  const result = await reporter.run(
    action === "install" ? `Configuring ${id}` : `Removing ${id} configuration`,
    () => service[action](id, options),
  );
  if (json) reporter.output({ action, result });
  else reporter.success(formatIntegrationChange(result));
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
