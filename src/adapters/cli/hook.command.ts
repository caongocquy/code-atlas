import path from "node:path";

import type { HookName } from "../../core/integration/integration.types.js";
import { GitHookService } from "../../core/integration/git-hook.service.js";

export async function runHookCommand(args: string[], repoPath = path.resolve(".")): Promise<void> {
  const [action] = args.filter((arg) => !arg.startsWith("--"));
  const hooks = selectedHooks(args);
  const service = new GitHookService(repoPath);
  if (action === "status") {
    process.stdout.write(`${JSON.stringify(await service.status(), null, 2)}\n`);
    return;
  }
  if (action === "install") {
    process.stdout.write(`${JSON.stringify(await service.install({ hooks }), null, 2)}\n`);
    return;
  }
  if (action === "uninstall") {
    process.stdout.write(`${JSON.stringify(await service.uninstall({ hooks }), null, 2)}\n`);
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
