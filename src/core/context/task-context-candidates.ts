import type { ContextSubject } from "./context.types.js";
import fs from "node:fs/promises";
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
  getStatus?: (...args: any[]) => Promise<any>;
  lexicalSearch?: (...args: any[]) => Promise<any[]>;
  hybridSearch?: (...args: any[]) => Promise<any>;
  inspectChange?: (...args: any[]) => Promise<any>;
  analyzeImpact?: (...args: any[]) => Promise<any>;
  affectedTests?: (...args: any[]) => Promise<any>;
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
  const candidates: TaskContextCandidate[] = [];
  let graph: CodeGraph;
  try {
    graph = (await deps.loadGraph()).graph;
  } catch (error) {
    return { candidates, reliability: { mayBeIncomplete: true, capabilityStates: { graph: "error" }, diagnostics: [error instanceof Error ? error.message : "graph unavailable"] } };
  }
  for (const anchor of normalized.anchors) {
    if (anchor.kind === "file") {
      try {
        await fs.access(`${deps.repositoryPath}/${anchor.path}`);
        candidates.push(exactFileCandidate(anchor.path, { kind: "explicit_anchor", anchor }));
      } catch { diagnostics.push(`anchor file is unavailable: ${anchor.path}`); }
      continue;
    }
    const anchorResolution = resolveGraphEntity(graph, anchor.path ? `${anchor.path}:${anchor.name}` : anchor.name);
    if (anchorResolution.status === "resolved" && anchorResolution.entity && anchorResolution.candidates.length === 1 && isAuthoritativeTaskResolution(anchor.path ? `${anchor.path}:${anchor.name}` : anchor.name, anchorResolution)) {
      const subject = subjectForNode(anchorResolution.entity);
      candidates.push({ subject, evidence: [{ kind: "explicit_anchor", anchor }], sourceRanks: { explicit_anchor: 1 }, exact: true });
    } else diagnostics.push(`symbol anchor is unresolved or ambiguous: ${anchor.name}`);
  }
  for (const changedPath of normalized.changedPaths) {
    try {
      await fs.access(`${deps.repositoryPath}/${changedPath}`);
      candidates.push(exactFileCandidate(changedPath, { kind: "explicit_changed_path", path: changedPath }));
    } catch { diagnostics.push(`changed path is unavailable: ${changedPath}`); }
  }
  const resolution = resolveGraphEntity(graph, normalized.task);
  if (resolution.status === "resolved" && isAuthoritativeTaskResolution(normalized.task, resolution)) {
    const subject = subjectForNode(resolution.entity);
    candidates.push({ subject, query: normalized.task, evidence: [{ kind: "task_exact_resolution", query: normalized.task, resolution: subject.kind }], sourceRanks: { task_exact_resolution: 1 }, exact: true });
  }
  if (resolution.status === "resolved") diagnostics.push(`task target was not exact: ${normalized.task}`);
  let mayBeIncomplete = false;
  const queries = [normalized.task, ...normalized.anchors.filter((anchor) => anchor.kind === "symbol").map((anchor) => anchor.name)].slice(0, 20);
  if (deps.lexicalSearch && !deps.hybridSearch) {
    try {
      for (const query of queries) {
        const results = await deps.lexicalSearch(query, 20, deps.repositoryPath);
        results.forEach((result, index) => {
          const node = result.symbolName ? graph.nodes.filter((candidate) => candidate.file === result.file && candidate.name === result.symbolName) : [];
          const subject = node.length === 1 ? subjectForNode(node[0]!) : { kind: "file" as const, path: result.file };
          candidates.push({ subject, evidence: [{ kind: "lexical", rank: index + 1, query }], sourceRanks: { lexical: index + 1 }, exact: true });
        });
      }
    } catch (error) { mayBeIncomplete = true; diagnostics.push(`lexical retrieval failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (deps.hybridSearch) {
    try {
      for (const query of queries) {
        const stages = await deps.hybridSearch(query, 20, deps.repositoryPath);
        for (const [kind, results] of [["semantic", stages.vectorResults], ["lexical", stages.lexicalResults]] as const) {
          (results ?? []).forEach((result: any, index: number) => {
            const subject = { kind: "file" as const, path: result.file };
            candidates.push({ subject, evidence: [{ kind, rank: index + 1, query }], sourceRanks: { [kind]: index + 1 }, exact: true });
          });
        }
        if (stages.semanticState === "error" || stages.semanticState === "unavailable") { mayBeIncomplete = true; diagnostics.push(`semantic retrieval is ${stages.semanticState}`); }
      }
    } catch (error) { mayBeIncomplete = true; diagnostics.push(`semantic retrieval failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  const capabilityStates: Record<string, string> = { graph: "ready" };
  if (deps.getStatus) { try { const status = await deps.getStatus(deps.repositoryPath); capabilityStates.lexical = status.capabilities?.lexical?.state ?? "unknown"; capabilityStates.semantic = status.capabilities?.semantic?.state ?? "unknown"; } catch { mayBeIncomplete = true; diagnostics.push("repository capability status unavailable"); } }
  return { candidates: mergeTaskContextCandidates(candidates), reliability: { mayBeIncomplete, capabilityStates, diagnostics } };
}

export function enrichTaskContextGraph(candidates: readonly TaskContextCandidate[], graph: CodeGraph): TaskContextCandidate[] {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const additions: TaskContextCandidate[] = [];
  for (const candidate of candidates) {
    if (!candidate.subject || !candidate.exact || candidate.subject.kind !== "symbol") continue;
    const seedId = candidate.subject.symbolId;
    const related = graph.edges
      .filter((edge) => edge.from === seedId || edge.to === seedId)
      .map((edge) => nodes.get(edge.from === seedId ? edge.to : edge.from))
      .filter((node): node is GraphNode => node !== undefined)
      .sort((a, b) => a.file.localeCompare(b.file) || a.id.localeCompare(b.id))
      .slice(0, 5);
    related.forEach((node, index) => {
      const subject = subjectForNode(node);
      additions.push({ subject, evidence: [{ kind: "graph", relation: "direct", from: seedId, depth: 1 }], sourceRanks: { graph: index + 1 }, exact: true });
    });
  }
  return mergeTaskContextCandidates([...candidates, ...additions]);
}

function relevancePaths(normalized: NormalizedTaskContextInput, candidates: readonly TaskContextCandidate[]): Set<string> {
  const paths = new Set(normalized.changedPaths.map(normalizedPath));
  for (const candidate of candidates) {
    if (candidate.priorityHint !== "required" && !candidate.evidence.some((evidence) => ["explicit_anchor", "explicit_changed_path", "task_exact_resolution"].includes(evidence.kind))) continue;
    if (candidate.subject) paths.add(normalizedPath(candidate.subject.path));
  }
  return paths;
}

function isRelevantNode(node: GraphNode, paths: Set<string>): boolean {
  return paths.has(normalizedPath(node.file));
}

function nodeQuery(node: GraphNode): string {
  return node.file.includes("/") && node.qualifiedName ? `${node.file}:${node.qualifiedName}` : node.qualifiedName ?? node.name;
}

export async function enrichTaskContextCandidates(
  candidates: readonly TaskContextCandidate[],
  normalized: NormalizedTaskContextInput,
  graph: CodeGraph,
  deps: TaskContextCollectionDeps,
): Promise<{ candidates: TaskContextCandidate[]; reliability: { mayBeIncomplete: boolean; diagnostics: string[] } }> {
  const paths = relevancePaths(normalized, candidates);
  if (!paths.size || (!deps.inspectChange && !deps.analyzeImpact && !deps.affectedTests)) return { candidates: [...candidates], reliability: { mayBeIncomplete: false, diagnostics: [] } };
  const additions: TaskContextCandidate[] = [];
  const diagnostics: string[] = [];
  let mayBeIncomplete = false;
  const seeds = graph.nodes.filter((node) => node.type !== "file" && paths.has(normalizedPath(node.file)) && candidates.some((candidate) => candidate.subject?.kind === "symbol" && candidate.subject.symbolId === node.id));

  if (deps.inspectChange) {
    try {
      const change = await deps.inspectChange(deps.repositoryPath, { mode: "working", maxDepth: 1 });
      mayBeIncomplete ||= Boolean(change.mayBeIncomplete);
      for (const symbol of [...(change.changedSymbols ?? []), ...(change.affectedSymbols ?? [])].slice(0, 10)) {
        const node = graph.nodes.find((candidate) => candidate.id === symbol.symbolId);
        if (!node || !isRelevantNode(node, paths)) continue;
        additions.push({ subject: subjectForNode(node), evidence: [{ kind: "change", relation: symbol.relation ?? symbol.changeKind ?? "changed", path: node.file }], sourceRanks: { change: 1 }, exact: true });
      }
    } catch (error) { mayBeIncomplete = true; diagnostics.push(`change enrichment failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (deps.analyzeImpact) {
    try {
      for (const seed of seeds.slice(0, 10)) {
        const impact = await deps.analyzeImpact(graph, nodeQuery(seed), { maxDepth: 1, maxResults: 10 });
        mayBeIncomplete ||= Boolean(impact.mayBeIncomplete);
        for (const item of [...(impact.directImpact ?? []), ...(impact.transitiveImpact ?? [])].slice(0, 10)) {
          if (!item.entity) continue;
          additions.push({ subject: subjectForNode(item.entity), evidence: [{ kind: "impact", relation: item.reason ?? item.relation ?? "impact", depth: Math.min(1, item.depth ?? 1) as 1 }], sourceRanks: { impact: item.depth ?? 1 }, exact: true });
        }
      }
    } catch (error) { mayBeIncomplete = true; diagnostics.push(`impact enrichment failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  if (deps.affectedTests) {
    try {
      const tests = await deps.affectedTests(deps.repositoryPath, { maxTests: 10, maxDepth: 1 });
      mayBeIncomplete ||= Boolean(tests.mayBeIncomplete);
      for (const test of (tests.tests ?? []).slice(0, 10)) {
        additions.push({ subject: { kind: "file", path: test.file }, evidence: [{ kind: "affected_test", path: test.file, confidence: test.confidence }], sourceRanks: { affected_test: 1 }, exact: true });
      }
    } catch (error) { mayBeIncomplete = true; diagnostics.push(`affected-test enrichment failed: ${error instanceof Error ? error.message : String(error)}`); }
  }
  return { candidates: mergeTaskContextCandidates([...candidates, ...additions]), reliability: { mayBeIncomplete, diagnostics } };
}
