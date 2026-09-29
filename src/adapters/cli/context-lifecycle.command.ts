import path from "node:path";

import { closeTaskContext, refreshTaskContext, startTaskContext } from "../../core/context/task-context-lifecycle.service.js";
import { TaskContextLifecycleDomainError, type StartTaskContextInput, type RefreshTaskContextInput, type CloseTaskContextInput } from "../../core/context/task-context-lifecycle.types.js";
import type { TaskContextAnchor } from "../../core/context/task-context.types.js";
import { createCliCommandReporter } from "./cli-command-reporter.js";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function repoPathFrom(args: string[], valueFlags: string[]): string {
  return path.resolve(args.find((arg, index) => !arg.startsWith("--") && !valueFlags.includes(args[index - 1] ?? "")) ?? ".");
}

function budgetFrom(args: string[]) {
  return {
    ...(valueAfter(args, "--budget-items") ? { maxItems: Number(valueAfter(args, "--budget-items")) } : {}),
    ...(valueAfter(args, "--budget-tokens") ? { maxEstimatedTokens: Number(valueAfter(args, "--budget-tokens")) } : {}),
  };
}

export function parseContextLifecycleArgs(command: "start", args: string[]): { repoPath: string; json: boolean; input: StartTaskContextInput };
export function parseContextLifecycleArgs(command: "refresh", args: string[]): { repoPath: string; json: boolean; input: RefreshTaskContextInput };
export function parseContextLifecycleArgs(command: "close", args: string[]): { repoPath: string; json: boolean; input: CloseTaskContextInput };
export function parseContextLifecycleArgs(command: "start" | "refresh" | "close", args: string[]): { repoPath: string; json: boolean; input: StartTaskContextInput | RefreshTaskContextInput | CloseTaskContextInput } {
  const json = args.includes("--json");
  const detail = args.includes("--full") ? "full" as const : "compact" as const;
  const valueFlags = ["--task", "--anchor-file", "--budget-items", "--budget-tokens", "--ttl"];
  const repoPath = repoPathFrom(args, valueFlags);
  if (command === "start") {
    const task = valueAfter(args, "--task");
    if (!task) throw new Error("--task is required.");
    const anchors: TaskContextAnchor[] = args.flatMap((arg, index) => arg === "--anchor-file" && args[index + 1] ? [{ kind: "file" as const, path: args[index + 1]! }] : []);
    return { repoPath, json, input: { task, anchors, budget: budgetFrom(args), ...(valueAfter(args, "--ttl") ? { ttlSeconds: Number(valueAfter(args, "--ttl")) } : {}), detail } };
  }
  const positional = args.filter((arg, index) => !arg.startsWith("--") && !valueFlags.includes(args[index - 1] ?? ""));
  const taskContextId = positional.at(-1);
  if (!taskContextId) throw new Error("<taskContextId> is required.");
  if (command === "refresh") return { repoPath, json, input: { taskContextId, budget: budgetFrom(args), detail } };
  return { repoPath, json, input: { taskContextId } };
}

export async function runContextLifecycleCommand(command: "start" | "refresh" | "close", args: string[]): Promise<void> {
  const parsed = command === "start" ? parseContextLifecycleArgs("start", args) : command === "refresh" ? parseContextLifecycleArgs("refresh", args) : parseContextLifecycleArgs("close", args);
  const reporter = createCliCommandReporter({ command: command === "start" ? "context-start" : command === "refresh" ? "context-refresh" : "context-close", json: parsed.json });
  try {
    const result = command === "start"
      ? await startTaskContext(parseContextLifecycleArgs("start", args).input, { repositoryPath: parsed.repoPath })
      : command === "refresh"
        ? await refreshTaskContext(parseContextLifecycleArgs("refresh", args).input, { repositoryPath: parsed.repoPath })
        : closeTaskContext(parseContextLifecycleArgs("close", args).input, { repositoryPath: parsed.repoPath });
    if (parsed.json) reporter.output(result);
    else reporter.success(JSON.stringify(result, null, 2));
  } catch (error) {
    process.exitCode = 1;
    if (parsed.json) reporter.output({ error: error instanceof TaskContextLifecycleDomainError ? error.operationError : error instanceof Error ? error.message : String(error) });
    else reporter.failure(`${command} failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
