import path from "node:path";

import { getWorkspaceIdentity } from "../../core/context/context-identity.js";
import { collectTaskContextCandidates, enrichTaskContextGraph } from "../../core/context/task-context-candidates.js";
import { compileTaskContext } from "../../core/context/task-context-compiler.js";
import { loadIndexedGraphReadOnly } from "../../core/graph/indexed-graph.service.js";
import { getRepositoryIdentity } from "../../core/repository/repository-identity.js";
import { createCliCommandReporter } from "./cli-command-reporter.js";

function valueAfter(args: string[], flag: string): string | undefined { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }

export function parseContextCompileArgs(args: string[]) {
  const task = valueAfter(args, "--task");
  if (!task) throw new Error("--task is required.");
  const valueFlags = ["--task", "--anchor-file", "--changed-path", "--budget-items", "--budget-tokens"];
  const repoPath = path.resolve(args.find((arg, index) => !arg.startsWith("--") && !valueFlags.includes(args[index - 1] ?? "")) ?? ".");
  return { repoPath, json: args.includes("--json"), input: { task, repoPath, anchors: args.flatMap((arg, index) => arg === "--anchor-file" && args[index + 1] ? [{ kind: "file" as const, path: args[index + 1]! }] : []), changedPaths: args.flatMap((arg, index) => arg === "--changed-path" && args[index + 1] ? [args[index + 1]!] : []), budget: { ...(valueAfter(args, "--budget-items") ? { maxItems: Number(valueAfter(args, "--budget-items")) } : {}), ...(valueAfter(args, "--budget-tokens") ? { maxEstimatedTokens: Number(valueAfter(args, "--budget-tokens")) } : {}) }, detail: args.includes("--full") ? "full" as const : "compact" as const } };
}

export async function runContextCompileCommand(args: string[]): Promise<void> {
  const parsed = parseContextCompileArgs(args);
  const reporter = createCliCommandReporter({ command: "context-compile", json: parsed.json });
  const graph = await loadIndexedGraphReadOnly(parsed.repoPath);
  const workspace = getWorkspaceIdentity(parsed.repoPath);
  const repository = getRepositoryIdentity(parsed.repoPath);
  const result = await compileTaskContext(parsed.input, { repositoryPath: parsed.repoPath, repositoryIdentity: repository.identityKey, workspaceIdentity: workspace.workspaceIdentity, collect: async (normalized) => { const collected = await collectTaskContextCandidates(normalized, { repositoryPath: parsed.repoPath, loadGraph: async () => graph }); return { ...collected, candidates: enrichTaskContextGraph(collected.candidates, graph.graph) }; } });
  if (parsed.json) reporter.output(result); else reporter.success(result.items.map((item) => `${item.priority.padEnd(10)} ${item.subject.kind}:${item.subject.path}`).join("\n") || "No context subjects selected.");
}
