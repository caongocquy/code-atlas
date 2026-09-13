import { createHash } from "node:crypto";

import { budgetTaskContext } from "./task-context-budget.js";
import { mergeTaskContextCandidates } from "./task-context-candidates.js";
import { normalizeTaskContextInput, createTaskIdentity } from "./task-context-normalizer.js";
import { rankTaskContextCandidates } from "./task-context-ranker.js";
import type { CompileTaskContextInput, NormalizedTaskContextInput, TaskContextCandidate, TaskContextPlanDetail, TaskContextReliability } from "./task-context.types.js";

type CompilerDeps = {
  repositoryPath: string;
  repositoryIdentity: string;
  workspaceIdentity: string;
  capabilityFingerprint?: string;
  collect: (normalized: NormalizedTaskContextInput) => Promise<{ candidates: TaskContextCandidate[]; reliability: TaskContextReliability }>;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export async function compileTaskContext(input: CompileTaskContextInput, deps: CompilerDeps): Promise<TaskContextPlanDetail> {
  const normalized = normalizeTaskContextInput(input);
  const taskIdentity = createTaskIdentity(normalized);
  const collected = await deps.collect(normalized);
  const ranked = rankTaskContextCandidates(mergeTaskContextCandidates(collected.candidates));
  const budgeted = budgetTaskContext(ranked, input.budget);
  const detail = input.detail ?? "compact";
  const items = budgeted.items.map(({ subject, priority, rank, reasons, estimatedTokens }) => ({ subject, priority, rank, reasons, ...(estimatedTokens === undefined ? {} : { estimatedTokens }) }));
  const capabilityFingerprint = deps.capabilityFingerprint ?? "none";
  const planPayload = { schemaVersion: 1, strategyVersion: "task-context-v1", taskIdentity, repositoryIdentity: deps.repositoryIdentity, workspaceIdentity: deps.workspaceIdentity, capabilityFingerprint, selectedItems: items.map((item) => ({ subject: item.subject, priority: item.priority, rank: item.rank, estimatedTokens: item.estimatedTokens })), budget: budgeted.budget };
  const planIdentity = `plan-v1:${createHash("sha256").update(stableJson(planPayload), "utf8").digest("hex")}`;
  const reliability: TaskContextReliability = { mayBeIncomplete: collected.reliability.mayBeIncomplete, capabilityStates: { ...collected.reliability.capabilityStates }, diagnostics: [...new Set([...collected.reliability.diagnostics, ...budgeted.diagnostics])].sort() };
  const fullItems = budgeted.items.map((item) => ({ ...item, evidence: item.evidence.slice(0, 8) }));
  const omitted = Math.min(20, ranked.length - budgeted.items.length);
  const truncated = ranked.length - budgeted.items.length > omitted || fullItems.some((item, index) => item.evidence.length < budgeted.items[index]!.evidence.length);
  return { taskIdentity, planIdentity, repositoryIdentity: deps.repositoryIdentity, workspaceIdentity: deps.workspaceIdentity, items, budget: budgeted.budget, reliability, capabilityFingerprint, compiler: { schemaVersion: 1, strategyVersion: "task-context-v1" }, projection: { detail, detailsAvailable: detail === "full", omitted, truncated }, ...(detail === "full" ? { fullItems } : {}) };
}
