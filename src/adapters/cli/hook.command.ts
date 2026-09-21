import path from "node:path";

import { createCliCommandReporter } from "./cli-command-reporter.js";
import { formatHookStatus } from "./cli-output.js";
import type { HookName } from "../../core/integration/integration.types.js";
import { GitHookService } from "../../core/integration/git-hook.service.js";

export async function runHookCommand(args: string[], repoPath = path.resolve(".")): Promise<void> {
  const [action] = args.filter((arg) => !arg.startsWith("--"));
  const reporter = createCliCommandReporter({ command: "hook", json: args.includes("--json") });
  const hooks = selectedHooks(args);
  const service = new GitHookService(repoPath);
  if (action === "status") {
    const result = await service.status();
    if (reporter.json) reporter.output(result);
    else reporter.success(formatHookStatus(result));
    return;
  }
  if (action === "install") {
    reporter.start("Installing CodeAtlas Git hooks...");
    const result = await reporter.run("Installing Git hooks", () => service.install({ hooks }));
    if (reporter.json) reporter.output(result);
    else reporter.success(formatHookStatus(result));
    return;
  }
  if (action === "uninstall") {
    reporter.start("Removing CodeAtlas Git hooks...");
    const result = await reporter.run("Removing Git hooks", () => service.uninstall({ hooks }));
    if (reporter.json) reporter.output(result);
    else reporter.success(formatHookStatus(result));
    return;
  }
  throw new Error("Usage: code-atlas hook install|uninstall|status [--post-commit] [--post-checkout]");
}

function selectedHooks(args: string[]): HookName[] | undefined {
  const hooks: HookName[] = [];
  if (args.includes("--post-commit")) hooks.push("post-commit");
  if (args.includes("--post-checkout")) hooks.push("post-checkout");
  return hooks.length > 0 ? hooks : undefined;
}
