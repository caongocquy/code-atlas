import type { ContextSubject } from "./context.types.js";
import { canonicalContextSubjectKey } from "./task-context-normalizer.js";
import type { TaskContextCandidate, TaskContextEvidence } from "./task-context.types.js";

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function evidenceKey(evidence: TaskContextEvidence): string {
  return stableJson(evidence);
}

function candidateKey(candidate: TaskContextCandidate): string {
  return candidate.subject ? `subject:${canonicalContextSubjectKey(candidate.subject)}` : `unresolved:${candidate.query ?? ""}:${candidate.evidence.map(evidenceKey).sort().join("|")}`;
}

function mergeTwo(left: TaskContextCandidate, right: TaskContextCandidate): TaskContextCandidate {
  const evidence = [...left.evidence, ...right.evidence]
    .filter((item, index, all) => all.findIndex((other) => evidenceKey(other) === evidenceKey(item)) === index)
    .sort((a, b) => a.kind.localeCompare(b.kind) || evidenceKey(a).localeCompare(evidenceKey(b)));
  const sourceRanks = { ...left.sourceRanks };
  for (const [kind, rank] of Object.entries(right.sourceRanks)) {
    if (rank !== undefined) sourceRanks[kind as keyof typeof sourceRanks] = Math.min(sourceRanks[kind as keyof typeof sourceRanks] ?? Number.POSITIVE_INFINITY, rank);
  }
  return {
    ...left,
    subject: left.subject ?? right.subject,
    query: left.query ?? right.query,
    priorityHint: left.priorityHint ?? right.priorityHint,
    evidence,
    sourceRanks,
    estimatedTokens: left.estimatedTokens ?? right.estimatedTokens,
    exact: left.exact || right.exact,
  };
}

export function mergeTaskContextCandidates(candidates: readonly TaskContextCandidate[]): TaskContextCandidate[] {
  const merged = new Map<string, TaskContextCandidate>();
  for (const candidate of candidates) {
    const key = candidateKey(candidate);
    const existing = merged.get(key);
    merged.set(key, existing ? mergeTwo(existing, candidate) : { ...candidate, evidence: [...candidate.evidence] });
  }
  return [...merged.values()].sort((a, b) => (a.subject?.kind ?? "").localeCompare(b.subject?.kind ?? "") || (a.subject?.path ?? a.query ?? "").localeCompare(b.subject?.path ?? b.query ?? "") || candidateKey(a).localeCompare(candidateKey(b)));
}

export function exactFileCandidate(path: string, evidence: TaskContextEvidence): TaskContextCandidate {
  const subject: ContextSubject = { kind: "file", path };
  return { subject, evidence: [evidence], sourceRanks: { [evidence.kind]: 1 }, exact: true };
}
