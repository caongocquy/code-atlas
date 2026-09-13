import type { ContextSubject } from "./context.types.js";
import type { GraphEntityResolution } from "../graph/query/graph-query.types.js";
import { resolveGraphEntity } from "../graph/query/graph-query-entity-resolver.js";
import type { CodeGraph, GraphNode } from "../graph/types.js";
import { CONTEXT_SUBJECT_SELECTOR_VERSION } from "./context.types.js";
import type { NormalizedTaskContextInput } from "./task-context.types.js";
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

function normalizeIdentifier(value: string): string {
  return value.normalize("NFC").replace(/([a-z0-9])([A-Z])/g, "$1 $2").replace(/[_./\\:#$-]+/g, " ").replace(/[^a-zA-Z0-9 ]+/g, " ").trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizedPath(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

export function isAuthoritativeTaskResolution(query: string, resolution: GraphEntityResolution): boolean {
  if (resolution.status !== "resolved") return false;
  const match = resolution.candidates.find((candidate) => candidate.entity.id === resolution.entity.id);
  if (!match) return false;
  const separator = query.lastIndexOf(":");
  const fileQualified = separator > 0 && /[\\/]/.test(query.slice(0, separator));
  if (fileQualified) {
    const requestedPath = normalizedPath(query.slice(0, separator));
    const requestedSymbol = query.slice(separator + 1);
    const symbolMatches = requestedSymbol.toLowerCase() === resolution.entity.name.toLowerCase() || requestedSymbol.toLowerCase() === (resolution.entity.qualifiedName ?? "").toLowerCase() || normalizeIdentifier(requestedSymbol) === normalizeIdentifier(resolution.entity.name) || normalizeIdentifier(requestedSymbol) === normalizeIdentifier(resolution.entity.qualifiedName ?? "");
    return match.reason === "file_path_context" && requestedPath === normalizedPath(resolution.entity.file) && symbolMatches;
  }
  return match.reason === "exact_qualified_name" || match.reason === "exact_symbol_name" || match.reason === "exact_normalized_token";
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

export type TaskContextCollectionDeps = {
  repositoryPath: string;
  loadGraph: () => Promise<{ graph: CodeGraph }>;
};

function subjectForNode(node: GraphNode): ContextSubject {
  if (node.type === "file") return { kind: "file", path: node.file };
  return { kind: "symbol", path: node.file, symbolId: node.id, selectorVersion: CONTEXT_SUBJECT_SELECTOR_VERSION };
}

export async function collectTaskContextCandidates(
  normalized: NormalizedTaskContextInput,
  deps: TaskContextCollectionDeps,
): Promise<{ candidates: TaskContextCandidate[]; reliability: { mayBeIncomplete: boolean; capabilityStates: Record<string, string>; diagnostics: string[] } }> {
  const diagnostics: string[] = [];
  let graph: CodeGraph;
  try {
    graph = (await deps.loadGraph()).graph;
  } catch (error) {
    return { candidates: [], reliability: { mayBeIncomplete: true, capabilityStates: { graph: "error" }, diagnostics: [error instanceof Error ? error.message : "graph unavailable"] } };
  }
  const resolution = resolveGraphEntity(graph, normalized.task);
  if (isAuthoritativeTaskResolution(normalized.task, resolution)) {
    const subject = subjectForNode(resolution.entity);
    return {
      candidates: [{ subject, query: normalized.task, evidence: [{ kind: "task_exact_resolution", query: normalized.task, resolution: subject.kind }], sourceRanks: { task_exact_resolution: 1 }, exact: true }],
      reliability: { mayBeIncomplete: false, capabilityStates: { graph: "ready" }, diagnostics },
    };
  }
  if (resolution.status === "resolved") diagnostics.push(`task target was not exact: ${normalized.task}`);
  return { candidates: [], reliability: { mayBeIncomplete: false, capabilityStates: { graph: "ready" }, diagnostics } };
}
