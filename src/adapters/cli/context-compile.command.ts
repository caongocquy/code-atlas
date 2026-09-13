import path from "node:path";

import { getWorkspaceIdentity } from "../../core/context/context-identity.js";
import { collectTaskContextCandidates, enrichTaskContextCandidates, enrichTaskContextGraph } from "../../core/context/task-context-candidates.js";
import { compileTaskContext } from "../../core/context/task-context-compiler.js";
import { loadIndexedGraphReadOnly } from "../../core/graph/indexed-graph.service.js";
import { getRepositoryIdentity } from "../../core/repository/repository-identity.js";
import { getRepositoryStatus } from "../../core/repository/repository-status.service.js";
import { searchLexical } from "../../core/lexical/lexical-search.service.js";
import { inspectHybridSearch } from "../../core/retrieval/hybrid-search.service.js";
import { inspectChange } from "../../core/change/inspect-change.service.js";
import { affectedTests } from "../../core/change/affected-tests.service.js";
import { analyzeImpact } from "../../core/graph/query/impact.service.js";
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
  const deps = { repositoryPath: parsed.repoPath, loadGraph: async () => graph, getStatus: getRepositoryStatus, lexicalSearch: searchLexical, hybridSearch: inspectHybridSearch, inspectChange, analyzeImpact: async (...args: Parameters<typeof analyzeImpact>) => analyzeImpact(...args), affectedTests };
  const result = await compileTaskContext(parsed.input, { repositoryPath: parsed.repoPath, repositoryIdentity: repository.identityKey, workspaceIdentity: workspace.workspaceIdentity, collect: async (normalized) => {
    const collected = await collectTaskContextCandidates(normalized, deps);
    const enriched = await enrichTaskContextCandidates(collected.candidates, normalized, graph.graph, deps);
    return { candidates: enrichTaskContextGraph(enriched.candidates, graph.graph), reliability: { ...collected.reliability, mayBeIncomplete: collected.reliability.mayBeIncomplete || enriched.reliability.mayBeIncomplete, diagnostics: [...collected.reliability.diagnostics, ...enriched.reliability.diagnostics] } };
  } });
  if (parsed.json) reporter.output(result); else reporter.success(result.items.map((item) => `${item.priority.padEnd(10)} ${item.subject.kind}:${item.subject.path}`).join("\n") || "No context subjects selected.");
}
