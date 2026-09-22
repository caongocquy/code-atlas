import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { installOfflineGuard } from "../context/offline-guard.js";
import { indexRepository } from "../../src/core/indexing/index-pipeline.service.js";
import type { ScipIndexer } from "../../src/core/indexing/scip-indexer.types.js";
import { loadIndexedGraphReadOnly } from "../../src/core/graph/indexed-graph.service.js";
import { resolveGraphEntity } from "../../src/core/graph/query/graph-query-entity-resolver.js";
import { expandGraphContextDetailed } from "../../src/core/graph/expand.js";
import type { CodeGraph, GraphNode } from "../../src/core/graph/types.js";
import { compileTaskContextForRepository } from "../../src/core/context/task-context-repository-compiler.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../../src/core/repository/index-version.js";
import { GRAPH_INDEX_VERSION, LEXICAL_INDEX_VERSION, RESOLUTION_VERSION, VECTOR_INDEX_VERSION } from "../../src/config/constants.js";
import { inspectRetrieval } from "../../src/core/retrieval/retrieval-inspector.service.js";
import type { InspectorChunk } from "../../src/core/retrieval/retrieval-inspector.service.js";
import type { EmbeddingProvider } from "../../src/core/semantic/embedding-provider.js";
import type { VectorPoint, VectorSearchResult, VectorStore } from "../../src/core/semantic/vector-store.js";
import type { SearchResult } from "../../src/core/retrieval/code-search.service.js";
import { aggregateRankingMetrics, canonicalIdentity, evaluateRanking, matchesSelector, type AmbiguityExpectation, type RankedCandidate, type RetrievalIdentity, type RetrievalJudgments, type RetrievalSelector, type RankingMetrics } from "./metrics.js";
import { RETRIEVAL_REPORT_SCHEMA_VERSION, validateRetrievalDataset, type FrozenSemanticCase, type RetrievalDataset, type RetrievalEvalCase, type ScipGraphPair, type SemanticProfile, type SemanticStyle } from "./types.js";

const PROFILE_NAMES = ["enabled", "disabled", "unavailable"] as const;
const EVAL_RRF_K = 60;
type ProfileName = (typeof PROFILE_NAMES)[number];
type EvaluationStage = "graphLookup" | "lexical" | "semantic" | "hybrid" | "hybridGraphExpansion" | "taskContext";
type Measurement = { ordered: string[]; candidates: RankedCandidate[]; metrics: RankingMetrics; sources: Record<string, number> };
export type RetrievalEvalOptions = { repoRoot: string; outputDirectory?: string; datasetPath?: string };

export type RetrievalEvalReport = {
  schemaVersion: typeof RETRIEVAL_REPORT_SCHEMA_VERSION;
  datasetVersion: string;
  source: { revision: string; workingTreeDirty: boolean };
  hashes: { dataset: string; evaluator: string; fixtures: Record<string, string> };
  indexVersions: { graph: string; lexical: string; vector: string; resolution: string; domains: typeof CURRENT_INDEX_VERSION_DOMAINS };
  semanticFixture: { provider: string; vectorStore: string; identity: string };
  options: { topK: number; rerankTopK: number; rrfK: number; graphEnabled: boolean; graphDepth: number; graphMaxNodes: number; tokenBudget: number; taskContextMaxItems: number; taskContextMaxEstimatedTokens: number };
  tokenCounter: { retrieval: string; taskContext: string };
  determinism: { passed: boolean; repeats: 2; comparedFields: string[] };
  semanticFallbacks: { deterministic: boolean; lexicalResultsMatchAcrossProfiles: boolean };
  cases: Array<{
    id: string; queryClass: string; fixture: string; split: string; profile: SemanticProfile;
    graphLookup: { status: string; candidates: Measurement };
    stages: Record<Exclude<EvaluationStage, "graphLookup" | "taskContext">, Measurement>;
    profiles: Record<ProfileName, { semanticState: string; vector: Measurement; lexical: Measurement; hybrid: Measurement; hybridGraphExpansion: Measurement; graphExpansion: { added: number; relations: Record<string, number> } }>;
    taskContext: { subjects: Measurement; coverage: { relevant: number; supporting: number }; admittedRelevantItems: number; missedRelevantItems: number; admittedSupportingItems: number; missedSupportingItems: number; budget: { maxItems: number; maxEstimatedTokens: number; selectedItems: number; estimatedTokens: number; omittedItems: number; budgetExceeded: boolean }; budgetEfficiency: number };
    ambiguity?: { expectation: AmbiguityExpectation; outcome: "no-result" | "no-promotion-observed" | "false-promotion" | "unique-target-promoted" | "incorrect-promotion" | "unjudged"; topIdentity: string | null };
    semanticStyle?: SemanticStyle;
  }>;
  aggregates: { byStage: Record<string, Record<string, number | null>>; bySplit: Record<string, Record<string, Record<string, number | null>>>; byQueryClass: Record<string, Record<string, number | null>>; byFixtureFamily: Record<string, Record<string, number | null>> };
  sourceContribution: { byStage: Record<string, Record<string, number>> };
  semanticComparison: Record<ProfileName, Record<string, number | null>>;
  semanticStyles: Record<SemanticStyle, Record<string, number | null>>;
  scipPairs: Array<{ caseId: string; conditions: Array<{ id: "parser-only" | "scip-enriched"; candidates: Measurement }> }>;
  judgmentQueue: { remainingTop5: number; remainingTop10: number; items: Array<{ caseId: string; fixture: string; split: string; queryClass: string; query: string; candidate: RetrievalIdentity; sources: Array<{ source: string; rank: number }>; appearances: number; priority: "top5" | "recurring" | "top10" | "ambiguity" | "held-out" | "graph-expansion-only" | "task-context" }> };
};

function sha256(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

async function hashDirectory(directory: string): Promise<string> {
  const files: Array<{ relativePath: string; bytes: Buffer }> = [];
  async function visit(current: string): Promise<void> {
    const entries = (await readdir(current, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absolute = path.join(current, entry.name);
      if (entry.isDirectory()) await visit(absolute);
      else if (entry.isFile()) files.push({ relativePath: path.relative(directory, absolute).split(path.sep).join("/"), bytes: await readFile(absolute) });
    }
  }
  await visit(directory);
  const hash = createHash("sha256");
  for (const file of files.sort((a, b) => a.relativePath.localeCompare(b.relativePath))) hash.update(file.relativePath).update("\0").update(file.bytes).update("\0");
  return hash.digest("hex");
}

function identityForNode(node: GraphNode): RetrievalIdentity {
  return node.type === "file"
    ? { kind: "file", path: node.file }
    : { kind: "symbol", path: node.file, name: node.name, symbolKind: node.type, ...(node.qualifiedName ? { qualifiedName: node.qualifiedName } : {}), ...(node.startLine === undefined ? {} : { startLine: node.startLine }) };
}

function findNode(graph: CodeGraph, selector: RetrievalSelector): GraphNode | undefined {
  return graph.nodes.find((node) => selector.kind === "file"
    ? node.type === "file" && node.file === selector.path
    : node.type === selector.symbolKind && node.file === selector.path && node.name === selector.name
      && (selector.qualifiedName === undefined || node.qualifiedName === selector.qualifiedName));
}

function identityForResult(graph: CodeGraph, result: SearchResult): RetrievalIdentity {
  const name = result.symbolName?.split(/\s+/)[0];
  const node = graph.nodes.find((candidate) => candidate.file === result.file && candidate.startLine === result.startLine
    && (result.symbolType === undefined || candidate.type === result.symbolType)
    && (name === undefined || candidate.name === name));
  if (node) return identityForNode(node);
  if (!result.symbolName || !result.file) return { kind: "file", path: result.file ?? "<unknown>" };
  const fallback = graph.nodes.find((candidate) => candidate.file === result.file && candidate.name === name);
  return fallback ? identityForNode(fallback) : { kind: "symbol", path: result.file, name, symbolKind: result.symbolType ?? "unknown", ...(result.startLine === undefined ? {} : { startLine: result.startLine }) };
}

function stableEvaluationResults<T extends SearchResult>(graph: CodeGraph, results: readonly T[], score: (result: T) => number): T[] {
  return [...results].sort((left, right) => score(right) - score(left)
    || canonicalIdentity(identityForResult(graph, left)).localeCompare(canonicalIdentity(identityForResult(graph, right))));
}

function retrievalResultKey(result: SearchResult): string {
  return [result.repoId ?? "", result.file ?? "", result.symbolType ?? "", result.symbolName ?? "", result.startLine ?? ""].join(":");
}

function normalizeFusionTies<T extends SearchResult & { fusionScore?: number; vectorRank?: number; lexicalRank?: number }>(results: readonly T[], vectorRanks: ReadonlyMap<string, number>, lexicalRanks: ReadonlyMap<string, number>): T[] {
  return results.map((result) => {
    const key = retrievalResultKey(result);
    const vectorRank = result.vectorRank === undefined ? undefined : vectorRanks.get(key) ?? result.vectorRank;
    const lexicalRank = result.lexicalRank === undefined ? undefined : lexicalRanks.get(key) ?? result.lexicalRank;
    const fusionScore = (vectorRank === undefined ? 0 : 1 / (EVAL_RRF_K + vectorRank))
      + (lexicalRank === undefined ? 0 : 1 / (EVAL_RRF_K + lexicalRank));
    return { ...result, ...(vectorRank === undefined ? {} : { vectorRank }), ...(lexicalRank === undefined ? {} : { lexicalRank }), fusionScore };
  });
}

function rankedResults(graph: CodeGraph, results: readonly SearchResult[]): RankedCandidate[] {
  return results.map((result) => ({ identity: identityForResult(graph, result), ...(result.startLine === undefined ? {} : { startLine: result.startLine }) }));
}

function rankedNodes(nodes: readonly GraphNode[]): RankedCandidate[] {
  return nodes.map((node) => ({ identity: identityForNode(node), ...(node.startLine === undefined ? {} : { startLine: node.startLine }) }));
}

function judgments(item: RetrievalEvalCase): RetrievalJudgments {
  return { relevant: item.relevant, supporting: item.supporting, irrelevant: item.irrelevant, forbidden: item.forbidden, exhaustive: item.exhaustive, ambiguous: item.ambiguous, expectation: item.expectation };
}

function judgmentRole(identity: RetrievalIdentity, item: RetrievalEvalCase): "relevant" | "supporting" | "irrelevant" | "forbidden" | undefined {
  for (const role of ["relevant", "supporting", "irrelevant", "forbidden"] as const) {
    if ((item[role] ?? []).some((selector) => matchesSelector(identity, selector))) return role;
  }
  return undefined;
}

function ambiguityResult(item: RetrievalEvalCase, candidates: readonly RankedCandidate[]): RetrievalEvalReport["cases"][number]["ambiguity"] {
  if (!item.expectation) return undefined;
  const first = candidates[0]?.identity;
  const topIdentity = first ? canonicalIdentity(first) : null;
  if (!first) return { expectation: item.expectation, outcome: "no-result", topIdentity };
  const role = judgmentRole(first, item);
  const outcome = item.expectation === "no-promotion"
    ? role === "forbidden" ? "false-promotion" : role ? "no-promotion-observed" : "unjudged"
    : role === "relevant" ? "unique-target-promoted" : role ? "incorrect-promotion" : "unjudged";
  return { expectation: item.expectation, outcome, topIdentity };
}

function validateFixtureJudgments(item: RetrievalEvalCase, graph: CodeGraph): void {
  const selectors = [...item.relevant, ...(item.supporting ?? []), ...(item.irrelevant ?? []), ...(item.forbidden ?? []), ...(item.semanticVectors?.candidates.map((candidate) => candidate.selector) ?? []), ...(item.scipPair ? [item.scipPair.seed, item.scipPair.target] : [])];
  for (const selector of selectors) if (!findNode(graph, selector)) throw new Error(`Unknown ${item.id} selector: ${selector.path}:${selector.kind === "symbol" ? selector.name : "<file>"}`);
  if (item.exhaustive) {
    const judged = [...item.relevant, ...(item.supporting ?? []), ...(item.irrelevant ?? []), ...(item.forbidden ?? [])];
    const missing = graph.nodes.find((node) => !judged.some((selector) => matchesSelector(identityForNode(node), selector)));
    if (missing) throw new Error(`Exhaustive judgments for ${item.id} omit ${missing.file}:${missing.name}`);
  }
}

function measure(candidates: readonly RankedCandidate[], item: RetrievalEvalCase, source?: readonly string[]): Measurement {
  const seen = new Map<string, number>();
  for (const entry of source ?? []) seen.set(entry, (seen.get(entry) ?? 0) + 1);
  return { ordered: candidates.map((candidate) => canonicalIdentity(candidate.identity)), candidates: [...candidates], metrics: evaluateRanking(candidates, judgments(item)), sources: Object.fromEntries([...seen.entries()].sort(([a], [b]) => a.localeCompare(b))) };
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

function cosine(left: readonly number[], right: readonly number[]): number {
  const dot = left.reduce((sum, value, index) => sum + value * (right[index] ?? 0), 0);
  const leftNorm = Math.sqrt(left.reduce((sum, value) => sum + value * value, 0));
  const rightNorm = Math.sqrt(right.reduce((sum, value) => sum + value * value, 0));
  return leftNorm && rightNorm ? dot / (leftNorm * rightNorm) : 0;
}

class FrozenEmbeddingProvider implements EmbeddingProvider {
  readonly id = "frozen-fixture-cosine-v1";
  readonly version = "1";
  readonly dimensions: number;
  constructor(private readonly vectors: FrozenSemanticCase) { this.dimensions = vectors.queryVector.length; }
  async isAvailable(): Promise<boolean> { return true; }
  async embedBatch(texts: string[]): Promise<number[][]> { return texts.map(() => [...this.vectors.queryVector]); }
  async countTokens(text: string): Promise<number> { return text.trim() ? text.trim().split(/\s+/).length : 0; }
}

class FrozenVectorStore implements VectorStore {
  readonly id = "frozen-fixture-vector-store-v1";
  private readonly points: VectorPoint[];
  constructor(vectors: FrozenSemanticCase, graph: CodeGraph, repoId: string) {
    this.points = vectors.candidates.flatMap(({ selector, vector }, index) => {
      const node = findNode(graph, selector);
      if (!node) throw new Error(`Frozen vector selector did not resolve in fixture graph: ${selector.path}:${selector.kind === "symbol" ? selector.name : "file"}`);
      return [{ id: index, vector, payload: { repoId, file: node.file, symbolName: node.name, symbolType: node.type, startLine: node.startLine, endLine: node.endLine, content: "" } }];
    });
  }
  async isAvailable(): Promise<boolean> { return true; }
  async ensureCollection(_dimensions: number): Promise<void> {}
  async search(repositoryId: string | undefined, vector: number[], limit: number): Promise<VectorSearchResult[]> {
    return this.points.filter((point) => repositoryId === undefined || point.payload.repoId === repositoryId)
      .map((point, index) => ({ result: { score: cosine(vector, point.vector), payload: point.payload }, index }))
      .sort((left, right) => right.result.score - left.result.score || left.index - right.index)
      .slice(0, limit).map(({ result }) => result);
  }
  async count(_repositoryId: string): Promise<number> { return this.points.length; }
  async getIndexedFileStates(): Promise<Map<string, never>> { return new Map(); }
  async upsert(_points: VectorPoint[]): Promise<void> {}
  async deletePointIds(_pointIds: Array<string | number>): Promise<void> {}
  async deleteFile(_repositoryId: string, _file: string): Promise<void> {}
}

function embeddingFor(vectors: FrozenSemanticCase): EmbeddingProvider {
  return new FrozenEmbeddingProvider(vectors);
}

function frozenProviders(vectors: FrozenSemanticCase | undefined, graph: CodeGraph, repoId: string, profile: ProfileName) {
  if (profile === "disabled") return undefined;
  if (profile === "unavailable") {
    return { embeddingProvider: { id: "frozen-fixture-cosine-v1", version: "1", dimensions: vectors?.queryVector.length ?? 2, isAvailable: async () => false, embedBatch: async () => [] }, vectorStore: new FrozenVectorStore(vectors ?? { queryVector: [1, 0], candidates: [] }, graph, repoId), semanticState: "ready" as const };
  }
  const fixture = vectors ?? { queryVector: [1, 0], candidates: [] };
  return { embeddingProvider: embeddingFor(fixture), vectorStore: new FrozenVectorStore(fixture, graph, repoId), semanticState: "ready" as const };
}

function sourceLabels(results: readonly InspectorChunk[]): string[] {
  return results.map((item) => item.source);
}

function graphExpansionSummary(results: readonly InspectorChunk[]): { added: number; relations: Record<string, number> } {
  const relations: Record<string, number> = {};
  for (const item of results) for (const provenance of item.provenance) if (provenance.stage === "graph") relations[provenance.relation ?? "unknown"] = (relations[provenance.relation ?? "unknown"] ?? 0) + 1;
  return { added: results.filter((item) => item.source === "graph").length, relations: Object.fromEntries(Object.entries(relations).sort(([a], [b]) => a.localeCompare(b))) };
}

function candidateForSubject(graph: CodeGraph, subject: { kind: string; path: string; symbolId?: string }): RankedCandidate | undefined {
  if (subject.kind === "file") return { identity: { kind: "file", path: subject.path } };
  const node = graph.nodes.find((candidate) => candidate.id === subject.symbolId);
  return node ? { identity: identityForNode(node), ...(node.startLine === undefined ? {} : { startLine: node.startLine }) } : undefined;
}

async function evaluateProfile(item: RetrievalEvalCase, root: string, graph: CodeGraph, repoId: string, profile: ProfileName) {
  const providers = frozenProviders(item.semanticVectors, graph, repoId, profile);
  const inspection = await inspectRetrieval(item.query, {
    repoPath: root,
    topK: 20,
    rerankTopK: 5,
    graphEnabled: true,
    graphDepth: 2,
    graphMaxNodes: 8,
    tokenBudget: 4_000,
    ...(providers ? { providers } : {}),
  });
  const vectorResults = stableEvaluationResults(graph, inspection.vectorResults, (result) => result.score);
  const lexicalResults = stableEvaluationResults(graph, inspection.lexicalResults, (result) => result.lexicalScore);
  const vectorRanks = new Map(vectorResults.map((result, index) => [retrievalResultKey(result), index + 1]));
  const lexicalRanks = new Map(lexicalResults.map((result, index) => [retrievalResultKey(result), index + 1]));
  const fusedResults = stableEvaluationResults(graph, normalizeFusionTies(inspection.fusedResults, vectorRanks, lexicalRanks), (result) => result.fusionScore);
  const normalizedExpanded = normalizeFusionTies(inspection.withGraph.chunks, vectorRanks, lexicalRanks);
  const expandedResults = [
    ...stableEvaluationResults(graph, normalizedExpanded.filter((result) => result.source !== "graph"), (result) => result.fusionScore ?? result.score),
    ...normalizedExpanded.filter((result) => result.source === "graph"),
  ];
  const vector = rankedResults(graph, vectorResults);
  const lexical = rankedResults(graph, lexicalResults);
  const hybrid = rankedResults(graph, fusedResults);
  const expanded = rankedResults(graph, expandedResults);
  return {
    semanticState: inspection.capabilities.semantic,
    vector: measure(vector, item, sourceLabels(vectorResults)),
    lexical: measure(lexical, item, sourceLabels(lexicalResults)),
    hybrid: measure(hybrid, item, sourceLabels(fusedResults)),
    hybridGraphExpansion: measure(expanded, item, sourceLabels(expandedResults)),
    graphExpansion: graphExpansionSummary(inspection.withGraph.chunks),
    resultKeys: {
      vector: vector.map((candidate) => canonicalIdentity(candidate.identity)),
      lexical: lexical.map((candidate) => canonicalIdentity(candidate.identity)),
      hybrid: hybrid.map((candidate) => canonicalIdentity(candidate.identity)),
      hybridGraphExpansion: expanded.map((candidate) => canonicalIdentity(candidate.identity)),
    },
  };
}

function graphLookup(item: RetrievalEvalCase, graph: CodeGraph): { status: string; candidates: Measurement } {
  const resolution = resolveGraphEntity(graph, item.query);
  const candidates = rankedNodes(resolution.candidates.map(({ entity }) => entity));
  return { status: resolution.status, candidates: measure(candidates, item) };
}

function taskContextMatches(identity: RetrievalIdentity, selector: RetrievalSelector): boolean {
  if (matchesSelector(identity, selector)) return true;
  return identity.kind === "file" && selector.kind === "symbol"
    && identity.path.replaceAll("\\", "/").replace(/^\.\//, "") === selector.path.replaceAll("\\", "/").replace(/^\.\//, "");
}

async function evaluateTaskContext(item: RetrievalEvalCase, root: string, graph: CodeGraph) {
  const plan = await compileTaskContextForRepository(root, { task: item.query, detail: "full", budget: { maxItems: 20, maxEstimatedTokens: 4_000 } });
  const candidates = plan.items.flatMap((entry) => {
    const candidate = candidateForSubject(graph, entry.subject);
    return candidate ? [candidate] : [];
  }).sort((left, right) => canonicalIdentity(left.identity).localeCompare(canonicalIdentity(right.identity)));
  const used = plan.budget.estimatedTokens;
  const admittedCount = (selectors: readonly RetrievalSelector[]): number => selectors.filter((selector) => candidates.some((candidate) => taskContextMatches(candidate.identity, selector))).length;
  const admittedRelevantItems = admittedCount(item.relevant);
  const admittedSupportingItems = admittedCount(item.supporting ?? []);
  const relevantCoverage = item.relevant.length ? admittedRelevantItems / item.relevant.length : 0;
  const supportingCoverage = item.supporting?.length ? admittedSupportingItems / item.supporting.length : 0;
  return {
    subjects: measure(candidates, item),
    coverage: { relevant: relevantCoverage, supporting: supportingCoverage },
    admittedRelevantItems,
    missedRelevantItems: item.relevant.length - admittedRelevantItems,
    admittedSupportingItems,
    missedSupportingItems: (item.supporting?.length ?? 0) - admittedSupportingItems,
    budget: plan.budget,
    budgetEfficiency: used ? relevantCoverage / used * 1_000 : 0,
    deterministicIdentity: stableJson({ subjects: candidates.map((candidate) => canonicalIdentity(candidate.identity)), budget: plan.budget }),
  };
}

function pairedScipExpansion(item: RetrievalEvalCase, graph: CodeGraph): RetrievalEvalReport["scipPairs"][number] | undefined {
  const pair: ScipGraphPair | undefined = item.scipPair;
  if (!pair) return undefined;
  const seed = findNode(graph, pair.seed);
  const target = findNode(graph, pair.target);
  if (!seed || !target) throw new Error(`SCIP pair selectors must resolve to fixture graph nodes for ${item.id}`);
  const parserOnly = expandGraphContextDetailed(graph, [{ file: seed.file, symbolName: seed.name, symbolType: seed.type, startLine: seed.startLine }], { maxDepth: 2, maxNodes: 8 });
  const enrichedGraph: CodeGraph = { nodes: [...graph.nodes], edges: [...graph.edges, { from: seed.id, to: target.id, type: pair.relation }] };
  const enriched = expandGraphContextDetailed(enrichedGraph, [{ file: seed.file, symbolName: seed.name, symbolType: seed.type, startLine: seed.startLine }], { maxDepth: 2, maxNodes: 8 });
  return {
    caseId: item.id,
    conditions: [
      { id: "parser-only", candidates: measure(rankedNodes(parserOnly.nodes), item, parserOnly.details.map((detail) => detail.relation)) },
      { id: "scip-enriched", candidates: measure(rankedNodes(enriched.nodes), item, enriched.details.map((detail) => detail.relation)) },
    ],
  };
}

function aggregateCases(cases: RetrievalEvalReport["cases"], selector: (item: RetrievalEvalReport["cases"][number]) => string | undefined): Record<string, Record<string, number | null>> {
  const groups = new Map<string, RankingMetrics[]>();
  for (const item of cases) {
    const group = selector(item);
    if (!group) continue;
    for (const [stage, measurement] of Object.entries(item.stages)) {
      const key = `${group}::${stage}`;
      groups.set(key, [...(groups.get(key) ?? []), measurement.metrics]);
    }
  }
  const result: Record<string, Record<string, number | null>> = {};
  for (const [key, metrics] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) result[key] = aggregateRankingMetrics(metrics);
  return result;
}

function buildJudgmentQueue(dataset: RetrievalDataset, cases: RetrievalEvalReport["cases"], scipPairs: RetrievalEvalReport["scipPairs"]): RetrievalEvalReport["judgmentQueue"] {
  type QueueItem = RetrievalEvalReport["judgmentQueue"]["items"][number];
  const byCase = new Map(cases.map((item) => [item.id, item]));
  const datasetById = new Map(dataset.cases.map((item) => [item.id, item]));
  const pending = new Map<string, Omit<QueueItem, "appearances" | "priority">>();
  const add = (item: RetrievalEvalCase, identity: RetrievalIdentity, source: string, rank: number): void => {
    const role = judgmentRole(identity, item);
    if (role || source === "task-context" && [item.relevant, item.supporting ?? [], item.irrelevant ?? [], item.forbidden ?? []].flat().some((selector) => taskContextMatches(identity, selector))) return;
    const key = `${item.id}\0${canonicalIdentity(identity)}`;
    const entry = pending.get(key) ?? { caseId: item.id, fixture: item.fixture, split: item.split, queryClass: item.queryClass, query: item.query, candidate: identity, sources: [] };
    if (!entry.sources.some((entrySource) => entrySource.source === source && entrySource.rank === rank)) entry.sources.push({ source, rank });
    pending.set(key, entry);
  };
  for (const item of dataset.cases) {
    const measured = byCase.get(item.id);
    if (!measured) continue;
    const base = measured.profiles.enabled.hybrid.candidates;
    const baseIdentities = new Set(base.map((candidate) => canonicalIdentity(candidate.identity)));
    for (const [rank, candidate] of base.slice(0, 10).entries()) add(item, candidate.identity, "hybrid", rank + 1);
    for (const [rank, candidate] of measured.profiles.enabled.hybridGraphExpansion.candidates.slice(0, 10).entries()) {
      if (!baseIdentities.has(canonicalIdentity(candidate.identity))) add(item, candidate.identity, "graph-expansion-only", rank + 1);
    }
    if (item.semanticVectors) {
      for (const [rank, candidate] of measured.profiles.enabled.vector.candidates.slice(0, 10).entries()) add(item, candidate.identity, "semantic-vector", rank + 1);
      for (const [rank, candidate] of measured.profiles.enabled.lexical.candidates.slice(0, 10).entries()) add(item, candidate.identity, "semantic-lexical", rank + 1);
    }
    for (const [rank, candidate] of measured.taskContext.subjects.candidates.entries()) add(item, candidate.identity, "task-context", rank + 1);
  }
  for (const pair of scipPairs) {
    const item = datasetById.get(pair.caseId);
    if (!item) continue;
    for (const condition of pair.conditions) for (const [rank, candidate] of condition.candidates.candidates.slice(0, 10).entries()) add(item, candidate.identity, condition.id === "parser-only" ? "scip-parser-only" : "scip-enriched", rank + 1);
  }
  const items = [...pending.values()];
  const appearances = new Map<string, number>();
  for (const item of items) appearances.set(canonicalIdentity(item.candidate), (appearances.get(canonicalIdentity(item.candidate)) ?? 0) + 1);
  const priorityOrder: Record<QueueItem["priority"], number> = { top5: 0, recurring: 1, top10: 2, ambiguity: 3, "held-out": 4, "graph-expansion-only": 5, "task-context": 6 };
  const resolved = items.map((item): QueueItem => {
    const caseData = datasetById.get(item.caseId)!;
    const count = appearances.get(canonicalIdentity(item.candidate)) ?? 1;
    const rankedRetrievalSources = new Set(["hybrid", "semantic-vector", "semantic-lexical"]);
    const retrievalRanks = item.sources.filter((source) => rankedRetrievalSources.has(source.source) && source.rank <= 5);
    const retrievalTop10 = item.sources.some((source) => rankedRetrievalSources.has(source.source) && source.rank <= 10);
    const priority: QueueItem["priority"] = retrievalRanks.length ? "top5" : count > 1 ? "recurring" : retrievalTop10 ? "top10" : caseData.ambiguous ? "ambiguity" : caseData.split === "held-out" ? "held-out" : item.sources.some((source) => source.source === "graph-expansion-only") ? "graph-expansion-only" : "task-context";
    return { ...item, sources: item.sources.sort((a, b) => a.source.localeCompare(b.source) || a.rank - b.rank), appearances: count, priority };
  }).sort((a, b) => priorityOrder[a.priority] - priorityOrder[b.priority] || b.appearances - a.appearances || a.caseId.localeCompare(b.caseId) || canonicalIdentity(a.candidate).localeCompare(canonicalIdentity(b.candidate)));
  return {
    remainingTop5: cases.reduce((sum, item) => sum + item.profiles.enabled.hybrid.metrics.unjudgedAt5, 0),
    remainingTop10: cases.reduce((sum, item) => sum + item.profiles.enabled.hybrid.metrics.unjudgedAt10, 0),
    items: resolved,
  };
}

function markdownReport(report: RetrievalEvalReport): string {
  const fmt = (value: number | null | undefined, digits = 3): string => typeof value === "number" ? value.toFixed(digits) : "n/a";
  const lines = [
    "# Retrieval Evaluation Candidate Baseline", "",
    `- Dataset: ${report.datasetVersion} (${report.hashes.dataset})`,
    `- CodeAtlas revision: ${report.source.revision}${report.source.workingTreeDirty ? " (working tree dirty)" : ""}`,
    `- Fixture families: ${Object.keys(report.hashes.fixtures).sort().join(", ")}`,
    `- Retrieval options: topK ${report.options.topK}, rerankTopK ${report.options.rerankTopK}, RRF k ${report.options.rrfK}, graph depth ${report.options.graphDepth}, graph max nodes ${report.options.graphMaxNodes}, token budget ${report.options.tokenBudget}`,
    `- Determinism: ${report.determinism.passed ? "PASS" : "FAIL"} (two identical-input runs)`,
    "", "## Aggregate by retrieval stage", "",
    "| Stage | MRR@5 | Recall@5 | Recall@10 | Hit@1 | Judged coverage @5 | Judged coverage @10 | Unjudged @5 | Unjudged @10 | Duplicate rate | Noise rate |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [stage, metrics] of Object.entries(report.aggregates.byStage)) lines.push(`| ${stage} | ${fmt(metrics.mrrAt5)} | ${fmt(metrics.recallAt5)} | ${fmt(metrics.recallAt10)} | ${fmt(metrics.hitAt1)} | ${fmt(metrics.judgedCoverageAt5)} | ${fmt(metrics.judgedCoverageAt10)} | ${metrics.unjudgedAt5 ?? 0} | ${metrics.unjudgedAt10 ?? 0} | ${fmt(metrics.canonicalDuplicateRate)} | ${fmt(metrics.judgedNoiseRate)} |`);
  lines.push("", "## Development vs held-out", "", "| Split | Stage | MRR@5 | Recall@5 | Recall@10 | Hit@1 | Judged coverage @5 | Judged coverage @10 | Unjudged @5 | Unjudged @10 |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const [split, groups] of Object.entries(report.aggregates.bySplit)) for (const [stage, metrics] of Object.entries(groups)) lines.push(`| ${split} | ${stage} | ${fmt(metrics.mrrAt5)} | ${fmt(metrics.recallAt5)} | ${fmt(metrics.recallAt10)} | ${fmt(metrics.hitAt1)} | ${fmt(metrics.judgedCoverageAt5)} | ${fmt(metrics.judgedCoverageAt10)} | ${metrics.unjudgedAt5 ?? 0} | ${metrics.unjudgedAt10 ?? 0} |`);
  for (const [title, aggregates] of [["Hybrid aggregate by query class", report.aggregates.byQueryClass], ["Hybrid aggregate by fixture family", report.aggregates.byFixtureFamily]] as const) {
    lines.push("", `## ${title}`, "", "| Group | Stage | MRR@5 | Recall@5 | Recall@10 | Hit@1 | Judged coverage @5 | Judged coverage @10 | Unjudged @5 | Unjudged @10 |", "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
    for (const [group, metrics] of Object.entries(aggregates)) lines.push(`| ${group} | hybrid | ${fmt(metrics.mrrAt5)} | ${fmt(metrics.recallAt5)} | ${fmt(metrics.recallAt10)} | ${fmt(metrics.hitAt1)} | ${fmt(metrics.judgedCoverageAt5)} | ${fmt(metrics.judgedCoverageAt10)} | ${metrics.unjudgedAt5 ?? 0} | ${metrics.unjudgedAt10 ?? 0} |`);
  }
  lines.push("", "## Semantic profile comparison", "", "| Profile | MRR@5 | Recall@5 | Recall@10 |", "| --- | ---: | ---: | ---: |");
  for (const name of PROFILE_NAMES) { const metrics = report.semanticComparison[name]!; lines.push(`| ${name} | ${fmt(metrics.mrrAt5)} | ${fmt(metrics.recallAt5)} | ${fmt(metrics.recallAt10)} |`); }
  lines.push("", "## Semantic query styles", "", "| Style | MRR@5 | Recall@5 | Recall@10 |", "| --- | ---: | ---: | ---: |");
  for (const [style, metrics] of Object.entries(report.semanticStyles)) lines.push(`| ${style} | ${fmt(metrics.mrrAt5)} | ${fmt(metrics.recallAt5)} | ${fmt(metrics.recallAt10)} |`);
  const taskCases = report.cases;
  const meanTask = (select: (item: RetrievalEvalReport["cases"][number]) => number): number => taskCases.length ? taskCases.reduce((sum, item) => sum + select(item), 0) / taskCases.length : 0;
  const sumTask = (select: (item: RetrievalEvalReport["cases"][number]) => number): number => taskCases.reduce((sum, item) => sum + select(item), 0);
  lines.push("", "## TaskContext coverage and budget efficiency", "", `- TaskContext admitted relevant items: ${sumTask((item) => item.taskContext.admittedRelevantItems)}`,
    `- TaskContext missed relevant items: ${sumTask((item) => item.taskContext.missedRelevantItems)}`,
    `- TaskContext admitted supporting items: ${sumTask((item) => item.taskContext.admittedSupportingItems)}`,
    `- TaskContext missed supporting items: ${sumTask((item) => item.taskContext.missedSupportingItems)}`,
    `- Required/relevant subject coverage: ${fmt(meanTask((item) => item.taskContext.coverage.relevant))}`,
    `- Supporting subject coverage: ${fmt(meanTask((item) => item.taskContext.coverage.supporting))}`,
    `- Relevant coverage per 1,000 estimated tokens: ${fmt(meanTask((item) => item.taskContext.budgetEfficiency))}`,
    `- Mean estimated tokens: ${fmt(meanTask((item) => item.taskContext.budget.estimatedTokens), 1)}`);
  const ambiguityCounts = new Map<string, number>();
  for (const item of report.cases) if (item.ambiguity) ambiguityCounts.set(item.ambiguity.outcome, (ambiguityCounts.get(item.ambiguity.outcome) ?? 0) + 1);
  lines.push("", "## Ambiguity outcomes", "", ...[...ambiguityCounts.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([outcome, count]) => `- ${outcome}: ${count}`), "", "| Case | Expectation | Outcome | Top candidate |", "| --- | --- | --- | --- |");
  for (const item of report.cases) if (item.ambiguity) lines.push(`| ${item.id} | ${item.ambiguity.expectation} | ${item.ambiguity.outcome} | ${item.ambiguity.topIdentity ?? "none"} |`);
  lines.push("", "## SCIP paired expansion", "");
  for (const pair of report.scipPairs) for (const condition of pair.conditions) lines.push(`- ${pair.caseId} / ${condition.id}: Recall@10 ${fmt(condition.candidates.metrics.recallAt10)}`);
  lines.push("", "## Unresolved judgment queue", "", `- Remaining hybrid unjudged appearances: @5 ${report.judgmentQueue.remainingTop5}; @10 ${report.judgmentQueue.remainingTop10}`,
    "", "| Priority | Case | Family | Split | Query class | Query | Candidate | Source ranks | Appearances |", "| --- | --- | --- | --- | --- | --- | --- | --- | --- | ---: |");
  for (const item of report.judgmentQueue.items) lines.push(`| ${item.priority} | ${item.caseId} | ${item.fixture} | ${item.split} | ${item.queryClass} | ${item.query} | ${canonicalIdentity(item.candidate)} | ${item.sources.map((source) => `${source.source}#${source.rank}`).join(", ")} | ${item.appearances} |`);
  lines.push("", "## Source contribution (candidate appearances by stage)", "");
  for (const [stage, sources] of Object.entries(report.sourceContribution.byStage)) lines.push(`- ${stage}: ${Object.entries(sources).map(([source, count]) => `${source} ${count}`).join(", ")}`);
  lines.push("", "Candidate report only. Promote to the frozen baseline only after explicit review.", "");
  return lines.join("\n");
}

export async function runRetrievalEval(options: RetrievalEvalOptions): Promise<{ report: RetrievalEvalReport; jsonPath: string; markdownPath: string }> {
  const repoRoot = path.resolve(options.repoRoot);
  const datasetPath = path.resolve(options.datasetPath ?? path.join(repoRoot, "eval/retrieval/dataset.json"));
  const datasetBytes = await readFile(datasetPath);
  const dataset = validateRetrievalDataset(JSON.parse(datasetBytes.toString("utf8")) as unknown);
  const outputDirectory = path.resolve(options.outputDirectory ?? path.join(repoRoot, "artifacts"));
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "code-atlas-retrieval-fixtures-"));
  const restoreOfflineGuard = installOfflineGuard();
  const fixtureHashes: Record<string, string> = {};
  const measuredCases: RetrievalEvalReport["cases"] = [];
  const scipPairs: RetrievalEvalReport["scipPairs"] = [];
  const sourceContribution: { byStage: Record<string, Record<string, number>> } = { byStage: {} };
  const addContribution = (stage: string, source: string, count: number): void => {
    const values = sourceContribution.byStage[stage] ??= {};
    values[source] = (values[source] ?? 0) + count;
  };
  let semanticFallbacksDeterministic = true;
  let lexicalParity = true;
  try {
    const groups = new Map<string, RetrievalEvalCase[]>();
    for (const item of dataset.cases) groups.set(item.fixture, [...(groups.get(item.fixture) ?? []), item]);
    for (const [fixture, cases] of [...groups.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      const fixtureSource = path.join(repoRoot, "eval/retrieval/fixtures", fixture);
      const fixtureRoot = path.join(tempRoot, fixture);
      fixtureHashes[fixture] = await hashDirectory(fixtureSource);
      await cp(fixtureSource, fixtureRoot, { recursive: true });
      const noScip: ScipIndexer = { discover: async () => ({ status: "unavailable" }), index: async () => [] };
      const indexed = await indexRepository(fixtureRoot, { skipGit: true, includeSemantic: false, scipIndexer: noScip });
      if (!indexed.published) throw new Error(`Could not build parser-only retrieval fixture ${fixture}: ${indexed.failure.message}`);
      const loaded = await loadIndexedGraphReadOnly(fixtureRoot);
      if (loaded.capabilityState !== "ready") throw new Error(`Retrieval fixture graph is not ready: ${fixture}`);

      for (const item of cases) {
        validateFixtureJudgments(item, loaded.graph);
        const lookupA = graphLookup(item, loaded.graph);
        const lookupB = graphLookup(item, loaded.graph);
        if (stableJson(lookupA) !== stableJson(lookupB)) semanticFallbacksDeterministic = false;
        const runs = await Promise.all(PROFILE_NAMES.map(async (profile) => {
          const [first, second] = await Promise.all([
            evaluateProfile(item, fixtureRoot, loaded.graph, loaded.repoId, profile),
            evaluateProfile(item, fixtureRoot, loaded.graph, loaded.repoId, profile),
          ]);
          if (stableJson(first) !== stableJson(second)) semanticFallbacksDeterministic = false;
          return [profile, first] as const;
        }));
        const profiles = Object.fromEntries(runs) as Record<ProfileName, Awaited<ReturnType<typeof evaluateProfile>>>;
        if (stableJson(profiles.enabled.resultKeys.lexical) !== stableJson(profiles.disabled.resultKeys.lexical)
          || stableJson(profiles.unavailable.resultKeys.lexical) !== stableJson(profiles.disabled.resultKeys.lexical)) lexicalParity = false;
        const [taskFirst, taskSecond] = await Promise.all([
          evaluateTaskContext(item, fixtureRoot, loaded.graph),
          evaluateTaskContext(item, fixtureRoot, loaded.graph),
        ]);
        if (taskFirst.deterministicIdentity !== taskSecond.deterministicIdentity) semanticFallbacksDeterministic = false;
        const stages = {
          lexical: profiles.disabled.lexical,
          semantic: profiles.enabled.vector,
          hybrid: profiles.enabled.hybrid,
          hybridGraphExpansion: profiles.enabled.hybridGraphExpansion,
        };
        addContribution("graphLookup", "graph", lookupA.candidates.candidates.length);
        addContribution("lexical", "lexical", profiles.enabled.lexical.candidates.length);
        addContribution("semantic", "vector", profiles.enabled.vector.candidates.length);
        for (const [source, count] of Object.entries(profiles.enabled.hybrid.sources)) addContribution("hybrid", source, count);
        for (const [source, count] of Object.entries(profiles.enabled.hybridGraphExpansion.sources)) addContribution("hybridGraphExpansion", source, count);
        addContribution("taskContext", "taskContext", taskFirst.subjects.candidates.length);
        const pair = pairedScipExpansion(item, loaded.graph);
        if (pair) scipPairs.push(pair);
        measuredCases.push({
          id: item.id, queryClass: item.queryClass, fixture: item.fixture, split: item.split, profile: item.profile,
          graphLookup: lookupA, stages,
          profiles: Object.fromEntries(PROFILE_NAMES.map((name) => [name, {
            semanticState: profiles[name]!.semanticState,
            vector: profiles[name]!.vector,
            lexical: profiles[name]!.lexical,
            hybrid: profiles[name]!.hybrid,
            hybridGraphExpansion: profiles[name]!.hybridGraphExpansion,
            graphExpansion: profiles[name]!.graphExpansion,
          }])) as RetrievalEvalReport["cases"][number]["profiles"],
          taskContext: { subjects: taskFirst.subjects, coverage: taskFirst.coverage, admittedRelevantItems: taskFirst.admittedRelevantItems, missedRelevantItems: taskFirst.missedRelevantItems, admittedSupportingItems: taskFirst.admittedSupportingItems, missedSupportingItems: taskFirst.missedSupportingItems, budget: taskFirst.budget, budgetEfficiency: taskFirst.budgetEfficiency },
          ...(item.expectation ? { ambiguity: ambiguityResult(item, profiles.enabled.hybrid.candidates) } : {}),
          ...(item.semanticStyle ? { semanticStyle: item.semanticStyle } : {}),
        });
      }
    }
  } finally {
    try { await rm(tempRoot, { recursive: true, force: true }); } finally { restoreOfflineGuard(); }
  }

  measuredCases.sort((a, b) => a.id.localeCompare(b.id));
  const byStage: Record<string, Record<string, number | null>> = {};
  for (const stage of ["graphLookup", "lexical", "semantic", "hybrid", "hybridGraphExpansion", "taskContext"] as const) {
    byStage[stage] = aggregateRankingMetrics(measuredCases.map((item) => stage === "graphLookup" ? item.graphLookup.candidates.metrics : stage === "taskContext" ? item.taskContext.subjects.metrics : item.stages[stage].metrics));
  }
  const semanticComparison = Object.fromEntries(PROFILE_NAMES.map((profile) => [profile, aggregateRankingMetrics(measuredCases.map((item) => item.profiles[profile].hybrid.metrics))])) as RetrievalEvalReport["semanticComparison"];
  const semanticStyles = Object.fromEntries((['direct-synonym', 'weak-lexical-overlap', 'mixed', 'no-added-value'] as const).map((style) => [style, aggregateRankingMetrics(measuredCases.filter((item) => item.semanticStyle === style).map((item) => item.profiles.enabled.hybrid.metrics))])) as RetrievalEvalReport["semanticStyles"];
  const bySplit = Object.fromEntries(['development', 'held-out'].map((split) => [split, aggregateCases(measuredCases, (item) => item.split === split ? 'hybrid' : undefined)]));
  const revision = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoRoot, encoding: "utf8" }).trim();
  const workingTreeDirty = execFileSync("git", ["status", "--porcelain"], { cwd: repoRoot, encoding: "utf8" }).trim().length > 0;
  const repeatPassed = semanticFallbacksDeterministic && lexicalParity;
  const report: RetrievalEvalReport = {
    schemaVersion: RETRIEVAL_REPORT_SCHEMA_VERSION,
    datasetVersion: dataset.datasetVersion,
    source: { revision, workingTreeDirty },
    hashes: { dataset: sha256(datasetBytes), evaluator: await hashDirectory(path.join(repoRoot, "eval/retrieval")), fixtures: Object.fromEntries(Object.entries(fixtureHashes).sort(([a], [b]) => a.localeCompare(b))) },
    indexVersions: { graph: GRAPH_INDEX_VERSION, lexical: LEXICAL_INDEX_VERSION, vector: VECTOR_INDEX_VERSION, resolution: RESOLUTION_VERSION, domains: CURRENT_INDEX_VERSION_DOMAINS },
    semanticFixture: { provider: "frozen-fixture-cosine-v1", vectorStore: "frozen-fixture-vector-store-v1", identity: dataset.semanticVectorFixtureId },
    options: { topK: 20, rerankTopK: 5, rrfK: EVAL_RRF_K, graphEnabled: true, graphDepth: 2, graphMaxNodes: 8, tokenBudget: 4_000, taskContextMaxItems: 20, taskContextMaxEstimatedTokens: 4_000 },
    tokenCounter: { retrieval: "frozen-fixture-whitespace-count-v1 (same whitespace rule as retrieval fallback)", taskContext: "task-context-estimated-token-v1" },
    determinism: { passed: repeatPassed, repeats: 2, comparedFields: ["canonical source order with unchanged RRF k=60 fusion for tied candidates", "canonical TaskContext admitted-subject inventory", "admission and budget metrics", "report aggregates"] },
    semanticFallbacks: { deterministic: semanticFallbacksDeterministic, lexicalResultsMatchAcrossProfiles: lexicalParity },
    cases: measuredCases,
    aggregates: { byStage, bySplit, byQueryClass: aggregateCases(measuredCases, (item) => item.queryClass), byFixtureFamily: aggregateCases(measuredCases, (item) => item.fixture) },
    sourceContribution: { byStage: Object.fromEntries(Object.entries(sourceContribution.byStage).sort(([a], [b]) => a.localeCompare(b)).map(([stage, sources]) => [stage, Object.fromEntries(Object.entries(sources).sort(([a], [b]) => a.localeCompare(b)))])) },
    semanticComparison,
    semanticStyles,
    scipPairs,
    judgmentQueue: buildJudgmentQueue(dataset, measuredCases, scipPairs),
  };
  await mkdir(outputDirectory, { recursive: true });
  const jsonPath = path.join(outputDirectory, "retrieval-eval-candidate.json");
  const markdownPath = path.join(outputDirectory, "retrieval-eval-candidate.md");
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(markdownPath, markdownReport(report));
  return { report, jsonPath, markdownPath };
}

export function renderRetrievalEvalMarkdown(report: RetrievalEvalReport): string { return markdownReport(report); }
export type { RetrievalDataset };
