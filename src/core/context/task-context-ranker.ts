import { canonicalContextSubjectKey } from "./task-context-normalizer.js";
import type { TaskContextCandidate, TaskContextEvidence, TaskContextFullItem, TaskContextPriority } from "./task-context.types.js";

function priority(candidate: TaskContextCandidate): TaskContextPriority {
  if (candidate.evidence.some((item) => item.kind === "explicit_anchor" || item.kind === "explicit_changed_path" || item.kind === "task_exact_resolution")) return "required";
  if (candidate.evidence.some((item) => item.kind === "graph" || item.kind === "change" || item.kind === "impact" || item.kind === "affected_test")) return "supporting";
  const retrieval = candidate.evidence.filter((item) => item.kind === "lexical" || item.kind === "semantic").length;
  return retrieval > 1 ? "supporting" : "optional";
}

function signal(candidate: TaskContextCandidate): number {
  return candidate.evidence.reduce((total, item) => {
    if (item.kind === "lexical" || item.kind === "semantic") return total + 1 / (60 + item.rank);
    const rank = candidate.sourceRanks[item.kind];
    return rank === undefined ? total : total + 1 / (60 + rank);
  }, 0);
}

function reason(item: TaskContextEvidence): string {
  if (item.kind === "explicit_anchor") return "explicit anchor";
  if (item.kind === "explicit_changed_path") return "explicit changed path";
  if (item.kind === "task_exact_resolution") return `${item.resolution} resolution`;
  if (item.kind === "lexical" || item.kind === "semantic" || item.kind === "hybrid") return `${item.kind} match rank ${item.rank}`;
  if (item.kind === "graph") return `direct graph ${item.relation}`;
  if (item.kind === "affected_test") return "affected test";
  return item.kind;
}

export function rankTaskContextCandidates(candidates: readonly TaskContextCandidate[]): TaskContextFullItem[] {
  const ranked = candidates.filter((candidate): candidate is TaskContextCandidate & { subject: NonNullable<TaskContextCandidate["subject"]> } => candidate.subject !== undefined).map((candidate) => ({
    subject: candidate.subject,
    priority: priority(candidate),
    rank: 0,
    reasons: [...new Set(candidate.evidence.map(reason))].sort(),
    ...(candidate.estimatedTokens === undefined ? {} : { estimatedTokens: candidate.estimatedTokens }),
    scoreSignal: signal(candidate),
    evidence: [...candidate.evidence],
    fusion: { sourceRanks: { ...candidate.sourceRanks } },
    exact: candidate.exact,
  }));
  const tiers: Record<TaskContextPriority, number> = { required: 0, supporting: 1, optional: 2 };
  ranked.sort((a, b) => tiers[a.priority] - tiers[b.priority] || b.scoreSignal - a.scoreSignal || Number(b.exact) - Number(a.exact) || b.evidence.length - a.evidence.length || canonicalContextSubjectKey(a.subject).localeCompare(canonicalContextSubjectKey(b.subject)));
  return ranked.map(({ exact: _exact, ...item }, index) => ({ ...item, rank: index + 1 }));
}
