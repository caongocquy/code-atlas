import fs from "node:fs/promises";
import path from "node:path";

import { GRAPH_INDEX_VERSION, LEXICAL_INDEX_VERSION, VECTOR_INDEX_VERSION } from "../../config/constants.js";
import { decodeFacts } from "../facts/facts-codec.js";
import { extractParsedFacts } from "../facts/facts-extractor.js";
import { factBlobKey } from "../facts/facts-identity.js";
import { buildCodeGraphWithResolutionFromFacts, normalizeFacts } from "../graph/build-graph.js";
import { isRelativeImport, resolveImportCandidates } from "../graph/imports.js";
import { parserMetadata } from "../graph/parsers/code-parser.js";
import { getLanguageAdapter } from "../graph/parsers/registry.js";
import { createBudgetLedger } from "../graph/resolver/budgets.js";
import { createGenerationResolverContext, type GenerationResolverContext } from "../graph/resolver/generation-context.js";
import { createResolverMemo } from "../graph/resolver/memo.js";
import { createTypeEnvironment } from "../graph/resolver/type-environment.js";
import { semanticAdapters } from "../graph/resolver/adapter-registry.js";
import { symbolIdentity, symbolIdentityKey, type SymbolIdentity } from "../graph/resolver/identities.js";
import type { LanguageSemanticAdapter } from "../graph/resolver/types.js";
import type { GraphResolutionFile, ResolutionDiagnostic, ResolutionEvidence } from "../graph/resolution.types.js";
import { withProvenance } from "../graph/resolver/provenance.js";
import type { CodeGraph } from "../graph/types.js";
import type { GraphResolutionFile as FactsGraphResolutionFile } from "../graph/build-graph.js";
import type { LexicalFileUpdate } from "../../storage/atlas/atlas.types.js";
import type { SemanticIndexResult } from "../semantic/semantic-index.service.js";
import { prepareSemanticCandidateFromFacts, type SemanticCandidate } from "../semantic/semantic-index.service.js";
import type { FactBlobKey } from "../facts/facts.types.js";
import type { ParsedFactsBlob } from "../facts/facts.types.js";
import type { SupportedLanguage } from "../graph/parsers/types.js";
import { AtlasStore } from "../../storage/atlas/atlas.store.js";
import { getRepositoryIdentity, canonicalRepositoryPath } from "../repository/repository-identity.js";
import { createFileHash } from "../repository/file-hash.js";
import { toLexicalDocumentsFromFacts } from "../lexical/lexical-index.service.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../repository/index-version.js";
import { detectRepositoryChanges } from "./change-detector.js";
import { createCandidateGeneration } from "./index-manifest.js";
import { planInvalidation } from "./invalidation-planner.js";
import { extractStableFacts, SourceRaceError, type SourceReader } from "./filesystem-change-detector.js";
import { createIndexWorkCounters, freezeIndexWorkCounters, recordIndexWork } from "./index-work-counters.js";
import { createCandidateResolutionInput } from "./resolution-scope.js";
import { createResolutionScope } from "./invalidation-planner.js";
import type { IndexPipelineOptions, IndexingChanges, IndexRunOutcome, IndexFailure, IndexedSourceUnit, PublishedIndexRun } from "./indexing.types.js";

const RESOLVER_BUDGETS = {
  candidateExpansions: 1000,
  bindingHops: 1000,
  returnDepth: 1000,
  inheritanceDepth: 1000,
  memberCandidates: 1000,
  expressionNodes: 1000,
  propagationRounds: 1000,
} as const;

export function buildPipelineResolverContext(input: {
  generationId: string;
  repositoryIdentity: ReturnType<typeof getRepositoryIdentity>;
  facts: readonly ParsedFactsBlob[];
  adapters: readonly LanguageSemanticAdapter[];
  resolutionVersion: string;
  relativePaths?: readonly string[];
}): GenerationResolverContext {
  const budget = createBudgetLedger(RESOLVER_BUDGETS);
  const memo = createResolverMemo();
  const base = createGenerationResolverContext({
    generationId: input.generationId,
    repositoryIdentity: input.repositoryIdentity,
    parsedFactsView: input.facts,
    languageRegistry: input.adapters,
    typeEnvironment: undefined as never,
    budget,
    memo,
    resolutionVersion: input.resolutionVersion,
  });
  const evidence = normalizeFacts(input.facts.map((facts, index) => ({
    facts,
    sourceUnit: {
      repositoryId: input.repositoryIdentity.id,
      relativePath: input.relativePaths?.[index] ?? "",
      language: facts.language,
    },
  })), base);
  const symbols = input.facts.flatMap((facts, index) => facts.symbols.map((fact) => symbolIdentity({
    repositoryId: input.repositoryIdentity.id,
    relativePath: input.relativePaths?.[index] ?? "",
    language: facts.language,
    kind: fact.kind,
    qualifiedName: fact.declaredQualifiedName ?? fact.name,
    discriminator: fact.localId,
  })));
  const typeEnvironment = createTypeEnvironment({ generationId: input.generationId, symbols, evidence, budget, memo });
  return createGenerationResolverContext({
    ...base,
    typeEnvironment,
    diagnostics: base.diagnostics,
  });
}

function toPersistedResolution(unit: IndexedSourceUnit, resolution: FactsGraphResolutionFile): GraphResolutionFile {
  const calls = resolution.decisions.filter((decision) => decision.edgeKind === "calls");
  const inheritance = resolution.decisions.filter((decision) => decision.edgeKind === "extends");
  const resolved = (items: typeof calls) => items.filter((item) => item.status === "resolved").length;
  const ambiguous = (items: typeof calls) => items.filter((item) => item.status === "ambiguous").length;
  const unresolved = (items: typeof calls) => items.filter((item) => item.status !== "resolved" && item.status !== "ambiguous").length;
  const diagnostics: ResolutionDiagnostic[] = [];
  for (const decision of resolution.decisions) {
    if (decision.status === "resolved") continue;
    const line = unit.facts.callSites.find((site) => site.localId === decision.site.localId)?.range.startLine
      ?? unit.facts.inheritances.find((site) => site.localId === decision.site.localId)?.range.startLine ?? 1;
    const source = { file: unit.relativePath, line };
    const evidence: ResolutionEvidence[] = decision.evidenceIds.length > 0
      ? decision.evidenceIds.map((evidenceId) => ({ evidenceKind: "INFERRED", source, detail: evidenceId }))
      : [{ evidenceKind: "EXTRACTED", source }];
    if (decision.status === "ambiguous") diagnostics.push({ kind: "ambiguous", candidates: decision.candidates.map((candidate) => symbolIdentityKey(candidate)), evidence, ambiguityReason: decision.reason, source });
    else diagnostics.push({ kind: "unresolved", evidence, reason: decision.reason, source, unsupportedDynamic: isUnsupportedDynamic(unit, decision.site.localId, decision.reason) });
  }
  const unsupportedDynamic = diagnostics.filter((diagnostic) => diagnostic.kind === "unresolved" && diagnostic.unsupportedDynamic).length;
  return {
    coverage: {
      calls: calls.length, resolvedCalls: resolved(calls), unresolvedCalls: unresolved(calls), ambiguousCalls: ambiguous(calls),
      extends: inheritance.length, resolvedExtends: resolved(inheritance), unresolvedExtends: unresolved(inheritance), ambiguousExtends: ambiguous(inheritance),
      parserErrors: unit.facts.parseStatus === "deterministic_partial" ? 1 : 0, unsupportedDynamic,
      mayBeIncomplete: diagnostics.length > 0 || unit.facts.parseStatus !== "complete",
    },
    diagnostics,
  };
}

function isUnsupportedDynamic(unit: IndexedSourceUnit, localId: string, reason: string): boolean {
  if (reason === "dynamic_expression" || reason === "runtime_dispatch") return true;
  const call = unit.facts.callSites.find((site) => site.localId === localId);
  return Boolean(call && /[?[\]*]/.test(call.calleeText));
}

function candidateSymbols(repoId: string, units: readonly IndexedSourceUnit[], graph: CodeGraph): Map<string, string> {
  const result = new Map<string, string>();
  for (const unit of units) {
    for (const fact of unit.facts.symbols) {
      const identity: SymbolIdentity = symbolIdentity({
        repositoryId: repoId,
        relativePath: unit.relativePath,
        language: unit.facts.language,
        kind: fact.kind,
        qualifiedName: fact.declaredQualifiedName ?? fact.name,
        discriminator: fact.localId,
      });
      const node = graph.nodes.find((candidate) => candidate.file === unit.relativePath
        && candidate.type === fact.kind
        && candidate.qualifiedName === identity.qualifiedName);
      if (node && !result.has(symbolIdentityKey(identity))) result.set(symbolIdentityKey(identity), node.id);
    }
  }
  return result;
}

function resolutionSourceFact(unit: IndexedSourceUnit, localId: string): string | undefined {
  const site = unit.facts.callSites.find((item) => item.localId === localId)
    ?? unit.facts.inheritances.find((item) => item.localId === localId)
    ?? unit.facts.implementations.find((item) => item.localId === localId)
    ?? unit.facts.references.find((item) => item.localId === localId);
  return (site as { callerId?: string; ownerId?: string; subjectId?: string; scopeId?: string } | undefined)?.callerId
    ?? (site as { ownerId?: string } | undefined)?.ownerId
    ?? (site as { subjectId?: string } | undefined)?.subjectId
    ?? unit.facts.symbols.find((symbol) => symbol.scopeId === (site as { scopeId?: string } | undefined)?.scopeId)?.localId
}

function sourceLine(unit: IndexedSourceUnit, localId: string): number {
  return unit.facts.callSites.find((site) => site.localId === localId)?.range.startLine
    ?? unit.facts.inheritances.find((site) => site.localId === localId)?.range.startLine ?? 1;
}

function addResolutionProvenance(
  graph: CodeGraph,
  units: readonly IndexedSourceUnit[],
  resolutions: ReadonlyMap<string, FactsGraphResolutionFile>,
  repoId: string,
  resolutionVersion: string,
): void {
  const byIdentity = candidateSymbols(repoId, units, graph);
  for (const unit of units) {
    for (const decision of resolutions.get(unit.relativePath)?.decisions ?? []) {
      if (decision.status !== "resolved" || (decision.edgeKind !== "calls" && decision.edgeKind !== "extends")) continue;
      const sourceLocalId = resolutionSourceFact(unit, decision.site.localId);
      const sourceFact = unit.facts.symbols.find((fact) => fact.localId === sourceLocalId);
      if (!sourceFact) continue;
      const sourceIdentity = symbolIdentity({ repositoryId: repoId, relativePath: unit.relativePath, language: unit.facts.language, kind: sourceFact.kind, qualifiedName: sourceFact.declaredQualifiedName ?? sourceFact.name, discriminator: sourceFact.localId });
      const sourceId = byIdentity.get(symbolIdentityKey(sourceIdentity));
      const targetId = byIdentity.get(symbolIdentityKey(decision.target));
      if (!sourceId || !targetId) continue;
      let edge = graph.edges.find((candidate) => candidate.from === sourceId && candidate.to === targetId && candidate.type === decision.edgeKind);
      if (!edge) {
        edge = { from: sourceId, to: targetId, type: decision.edgeKind };
        graph.edges.push(edge);
      }
      const evidence = decision.evidenceIds.map((evidenceId) => ({ kind: "resolver", sourceUnit: unit.relativePath, startLine: sourceLine(unit, decision.site.localId), endLine: sourceLine(unit, decision.site.localId), evidenceId }));
      Object.assign(edge, withProvenance(edge, { strategy: decision.strategy, confidence: decision.confidence, evidence, resolutionVersion, sourceLogicalIdentity: symbolIdentityKey(sourceIdentity), targetLogicalIdentity: symbolIdentityKey(decision.target) }));
    }
  }
}

function rebindUnchangedSemanticEdges(
  graph: CodeGraph,
  previousGraph: CodeGraph,
  units: readonly IndexedSourceUnit[],
  repoId: string,
  resolutionVersion: string,
  resolvedPaths: ReadonlySet<string>,
): void {
  const byIdentity = candidateSymbols(repoId, units, graph);
  const previousNodes = new Map(previousGraph.nodes.map((node) => [node.id, node]));
  for (const edge of previousGraph.edges) {
    if (edge.type !== "calls" && edge.type !== "extends") continue;
    const previousFrom = previousNodes.get(edge.from);
    const previousTo = previousNodes.get(edge.to);
    if (resolvedPaths.has(previousFrom?.file ?? "") || resolvedPaths.has(previousTo?.file ?? "")) continue;
    if (!edge.resolution || edge.resolution.resolutionVersion !== resolutionVersion) continue;
    const from = byIdentity.get(edge.resolution.sourceLogicalIdentity);
    const to = byIdentity.get(edge.resolution.targetLogicalIdentity);
    if (!from || !to || graph.edges.some((candidate) => candidate.from === from && candidate.to === to && candidate.type === edge.type)) continue;
    graph.edges.push({ ...edge, from, to });
  }
  graph.edges = [...new Map(graph.edges.map((edge) => [`${edge.from}:${edge.to}:${edge.type}`, edge])).values()]
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.type.localeCompare(right.type));
}

type LegacyIndexResult = {
  repoPath: string; repoId: string; operation: "index" | "sync"; changeDetection: "git" | "filesystem";
  changes: Pick<IndexingChanges, "addedFiles" | "changedFiles" | "deletedFiles" | "candidateFiles">;
  graph: { repoPath: string; repoId: string; status: "indexed" | "current"; storedVersion?: string; version: string; versionChanged: boolean; fullRebuild: boolean; files: number; addedFiles: number; changedFiles: number; unchangedFiles: number; deletedFiles: number; impactedFiles: number; nodes: number; edges: number; totalMs: number };
  lexical: { repoPath: string; repoId: string; status: "indexed" | "current"; version: string; versionChanged: boolean; fullRebuild: boolean; files: number; indexedFiles: number; skippedFiles: number; deletedFiles: number; documents: number; totalMs: number };
  semantic?: SemanticIndexResult; totalMs: number;
};

export type IndexPipelineResult = PublishedIndexRun & LegacyIndexResult;

class CacheWriteFailure extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CacheWriteFailure";
  }
}

function failure(error: unknown, activeGenerationId?: string): IndexFailure {
  const kind = error instanceof SourceRaceError
    ? "source_race"
    : error instanceof CacheWriteFailure
      ? "cache_write_failure"
      : "infrastructure_failure";
  return { kind, message: error instanceof Error ? error.message : String(error), ...(activeGenerationId ? { activeGenerationId } : {}) };
}

function semanticResult(
  repoPath: string,
  repoId: string,
  status: SemanticIndexResult["status"],
  startedAt: number,
  candidate?: SemanticCandidate,
  error?: string,
): SemanticIndexResult {
  return {
    repoPath, repoId, status, version: VECTOR_INDEX_VERSION,
    fullReindex: false, files: candidate?.files ?? 0, chunks: candidate?.chunks ?? 0,
    points: candidate?.points.length ?? 0, embeddedSymbols: candidate?.embeddedSymbols ?? 0,
    cleanedOldPoints: 0, embeddingBatches: candidate?.embeddingBatches ?? 0,
    vectorBatches: candidate?.points.length ? 1 : 0, addedFiles: 0, updatedFiles: 0,
    skippedFiles: 0, deletedFiles: 0, totalMs: performance.now() - startedAt,
    ...(error ? { error } : {}),
  };
}

async function runPipeline(inputPath: string, operation: "index" | "sync", options: IndexPipelineOptions): Promise<IndexRunOutcome> {
  const startedAt = performance.now();
  const repoPath = canonicalRepositoryPath(path.resolve(inputPath));
  const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
  const repoId = store.ensureRepository(getRepositoryIdentity(repoPath)).id;
  const counters = createIndexWorkCounters();
  const readSource: SourceReader = async (relativePath) => {
    const source = await fs.readFile(path.join(repoPath, relativePath), "utf8");
    return { source, contentHash: createFileHash(source) };
  };
  let activeGenerationId = store.getActiveGenerationId(repoId);
  const legacyRepository = !store.hasV2RepositoryState(repoId) &&
    store.getFileCapabilityStates(repoId, "graph").size > 0;
  let semanticCandidate: SemanticCandidate | undefined;

  try {
    const storedLexicalVersion = store.getVersion(repoId, "lexical");
    const capabilities = options.includeSemantic ? ["graph", "lexical", "semantic"] as const : ["graph", "lexical"] as const;
    const changes = await detectRepositoryChanges(repoPath, { store, repoId, capabilities: [...capabilities], versions: { graph: GRAPH_INDEX_VERSION, lexical: LEXICAL_INDEX_VERSION, semantic: VECTOR_INDEX_VERSION }, skipGit: options.skipGit, progress: options.progress, forceFullScan: operation === "index" || legacyRepository });
    recordIndexWork(counters, "filesScanned", changes.relativeFiles.length);
    recordIndexWork(counters, "filesHashed", changes.fileHashes.size);
    const previousManifest = store.getGenerationManifest(repoId);
    const previousBindings = new Map(previousManifest?.files.map((file) => [file.relativePath, file]) ?? []);
    const currentFiles = new Map<string, { contentHash: string; language: SupportedLanguage }>();
    const sources = new Map<string, string>();

    for (const relativePath of changes.relativeFiles) {
      const adapter = getLanguageAdapter(relativePath);
      const contentHash = changes.fileHashes.get(relativePath);
      if (!adapter || !contentHash) continue;
      currentFiles.set(relativePath, { contentHash, language: adapter.language });
      sources.set(relativePath, await fs.readFile(path.join(repoPath, relativePath), "utf8"));
    }

    const units: IndexedSourceUnit[] = [];
    const bindings: Array<{ repositoryId: string; relativePath: string; generationId: string; factBlobKey: FactBlobKey; contentHash: string; language: SupportedLanguage }> = [];

    for (const [relativePath, current] of currentFiles) {
      let source = sources.get(relativePath);
      const adapter = getLanguageAdapter(relativePath);
      if (source === undefined || !adapter) continue;
      const parserIdentity = parserMetadata(adapter);
      const expected = { contentHash: current.contentHash, language: current.language, parserIdentity, factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion, factsSchemaVersion: CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion };
      let key = factBlobKey(expected);
      const cached = decodeFacts(store.getFactBlob(key), { key, ...expected });
      let facts;
      if (cached.kind === "hit") {
        const stableCached = await extractStableFacts(
          relativePath,
          readSource,
          () => ({ kind: "facts", facts: cached.facts }),
        );
        if (createFileHash(stableCached.source) === cached.facts.contentHash) {
          recordIndexWork(counters, "factCacheHits");
          source = stableCached.source;
          facts = cached.facts;
        } else {
          recordIndexWork(counters, "factCacheMisses");
          recordIndexWork(counters, "filesParsed");
          const stable = await extractStableFacts(
            relativePath,
            readSource,
            (read) => extractParsedFacts({ filePath: relativePath, source: read.source, language: current.language, contentHash: read.contentHash, factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion, factsSchemaVersion: CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion }),
          );
          source = stable.source;
          facts = stable.facts;
          key = factBlobKey({ ...expected, contentHash: facts.contentHash });
          try { store.putFactBlob(key, facts); } catch (error) { throw new CacheWriteFailure(`Fact cache write failed for ${relativePath}: ${error instanceof Error ? error.message : String(error)}`); }
        }
      } else {
        recordIndexWork(counters, "factCacheMisses");
        recordIndexWork(counters, "filesParsed");
        const stable = await extractStableFacts(
          relativePath,
          readSource,
          (read) => extractParsedFacts({ filePath: relativePath, source: read.source, language: current.language, contentHash: read.contentHash, factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion, factsSchemaVersion: CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion }),
        );
        source = stable.source;
        facts = stable.facts;
        key = factBlobKey({ ...expected, contentHash: facts.contentHash });
        try { store.putFactBlob(key, facts); } catch (error) { throw new CacheWriteFailure(`Fact cache write failed for ${relativePath}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      units.push({ relativePath, source, facts });
      bindings.push({ repositoryId: repoId, relativePath, generationId: "pending", factBlobKey: key, contentHash: facts.contentHash, language: current.language });
    }

    const directImporters = new Map<string, Set<string>>();
    const addImporter = (target: string, importer: string) => {
      const importers = directImporters.get(target) ?? new Set<string>();
      importers.add(importer);
      directImporters.set(target, importers);
    };
    const previousGraph = store.loadGraph(repoId);
    const previousNodes = new Map(previousGraph.nodes.map((node) => [node.id, node]));
    for (const edge of previousGraph.edges) {
      if (edge.type !== "imports") continue;
      const importer = previousNodes.get(edge.from)?.file;
      const target = previousNodes.get(edge.to)?.file;
      if (importer && target) addImporter(target, importer);
    }
    const currentFileSet = new Set(currentFiles.keys());
    for (const unit of units) {
      for (const reference of unit.facts.imports) {
        const targets = isRelativeImport(reference.moduleSpecifier)
          ? resolveImportCandidates(unit.relativePath, reference.moduleSpecifier)
          : [`module:${reference.moduleSpecifier}`];
        const resolvedTarget = targets.find((target) => currentFileSet.has(target));
        if (resolvedTarget) {
          addImporter(resolvedTarget, unit.relativePath);
        } else {
          for (const target of targets) addImporter(target.startsWith("module:") ? target : `unresolved:${target}`, unit.relativePath);
        }
      }
    }
    const plan = planInvalidation({ repositoryFiles: [...currentFiles.keys()], currentFiles, previousBindings, directImporters, versions: CURRENT_INDEX_VERSION_DOMAINS, previousVersions: previousManifest?.versions });
    recordIndexWork(counters, "importersInvalidated", plan.importersInvalidated.length);

    const generation = createCandidateGeneration(repoId, activeGenerationId, CURRENT_INDEX_VERSION_DOMAINS, bindings);
    store.beginCandidateGeneration(generation);
    store.writeCandidateManifest(generation.manifest);
    const scope = createResolutionScope(plan);
    const candidateInput = createCandidateResolutionInput(units, scope, activeGenerationId, previousGraph);
    const resolverContext = buildPipelineResolverContext({
      generationId: generation.id,
      repositoryIdentity: getRepositoryIdentity(repoPath),
      facts: candidateInput.allUnits.map((unit) => unit.facts),
      adapters: semanticAdapters,
      resolutionVersion: CURRENT_INDEX_VERSION_DOMAINS.resolutionVersion,
      relativePaths: candidateInput.allUnits.map((unit) => unit.relativePath),
    });
    const graphCompatible = plan.parsePaths.length === 0 && plan.resolvePaths.length === 0 && plan.removedPaths.length === 0 && previousManifest !== undefined;
    const graph = graphCompatible
      ? { graph: structuredClone(previousGraph), resolutionByFile: new Map() }
      : await buildCodeGraphWithResolutionFromFacts(repoPath, candidateInput.allUnits, undefined, repoId, candidateInput.scope.paths, resolverContext);
    if (graphCompatible) {
      graph.graph.edges = graph.graph.edges.filter((edge) => edge.type !== "calls" && edge.type !== "extends");
      rebindUnchangedSemanticEdges(graph.graph, previousGraph, candidateInput.allUnits, repoId, resolverContext.resolutionVersion, new Set());
    } else {
      addResolutionProvenance(graph.graph, candidateInput.allUnits, graph.resolutionByFile, repoId, resolverContext.resolutionVersion);
      if (previousManifest !== undefined) rebindUnchangedSemanticEdges(graph.graph, previousGraph, candidateInput.allUnits, repoId, resolverContext.resolutionVersion, new Set(candidateInput.scope.paths));
    }
    const persistedResolution = new Map(
      [...graph.resolutionByFile].map(([file, resolution]) => {
        const unit = candidateInput.allUnits.find((candidate) => candidate.relativePath === file);
        if (!unit) return undefined;
        return "decisions" in resolution
          ? [file, toPersistedResolution(unit, resolution)] as const
          : [file, resolution] as const;
      }).filter((entry): entry is readonly [string, GraphResolutionFile] => entry !== undefined),
    );
    recordIndexWork(counters, "filesResolved", persistedResolution.size);
    if (plan.fullGraphResolution && !graphCompatible) recordIndexWork(counters, "fullResolutionFallbacks");
    store.writeCandidateGraph(generation.id, graph.graph, changes.fileHashes, graphCompatible ? undefined : persistedResolution, plan.reusePaths);
    const lexical: LexicalFileUpdate[] = units.map((unit) => ({ file: unit.relativePath, fileHash: unit.facts.contentHash, documents: toLexicalDocumentsFromFacts(repoId, unit) }));
    store.writeCandidateLexicalDocuments(generation.id, lexical);
    const semanticStartedAt = performance.now();
    let semantic: SemanticIndexResult | undefined;
    const activeSemanticEnabled = store.hasActiveSemanticCapability(repoId);
    let semanticPreserved = false;
    if (options.includeSemantic) {
      const providers = options.semanticProviders;
      if (!providers) {
        if (activeSemanticEnabled) throw new Error("Semantic provider is not configured while an active semantic capability exists");
        semantic = semanticResult(repoPath, repoId, "not-configured", semanticStartedAt);
      } else {
        try {
          const available = await providers.embeddingProvider.isAvailable() && await providers.vectorStore.isAvailable();
          if (!available) {
            if (activeSemanticEnabled) throw new Error("Semantic provider is unavailable while an active semantic capability exists");
            semantic = semanticResult(repoPath, repoId, "unavailable", semanticStartedAt);
          } else {
            semanticCandidate = await prepareSemanticCandidateFromFacts(repoId, generation.id, units, providers.embeddingProvider, providers.vectorStore);
            semantic = semanticResult(repoPath, repoId, "indexed", semanticStartedAt, semanticCandidate);
          }
        } catch (error) {
          if (activeSemanticEnabled) throw error;
          semantic = semanticResult(repoPath, repoId, "unavailable", semanticStartedAt, undefined, error instanceof Error ? error.message : String(error));
        }
      }
    } else if (activeSemanticEnabled) {
      store.copyActiveSemanticVectorsToCandidate(generation.id);
      semanticPreserved = true;
    }
    if (semanticCandidate) store.writeCandidateSemanticVectors(generation.id, semanticCandidate.points);
    const previousSemanticStates = semanticPreserved ? store.getFileCapabilityStates(repoId, "semantic") : undefined;
    const fileStates = units.flatMap((unit) => {
      const graphCount = graph.graph.nodes.filter((node) => node.file === unit.relativePath).length;
      const lexicalCount = lexical.find((update) => update.file === unit.relativePath)?.documents.length ?? 0;
      const semanticCount = semanticCandidate?.points.filter((point) => point.payload.file === unit.relativePath).length ?? 0;
      const preservedSemantic = previousSemanticStates?.get(unit.relativePath);
      return [
        { file: unit.relativePath, capability: "graph" as const, input: { fileHash: unit.facts.contentHash, version: GRAPH_INDEX_VERSION, state: "ready" as const, generation: generation.id, itemCount: graphCount } },
        { file: unit.relativePath, capability: "lexical" as const, input: { fileHash: unit.facts.contentHash, version: LEXICAL_INDEX_VERSION, state: "ready" as const, generation: generation.id, itemCount: lexicalCount } },
        ...(semanticCandidate ? [{ file: unit.relativePath, capability: "semantic" as const, input: { fileHash: unit.facts.contentHash, version: VECTOR_INDEX_VERSION, state: "ready" as const, generation: generation.id, providerIdentity: semanticCandidate.providerIdentity, itemCount: semanticCount } }] : []),
        ...(preservedSemantic ? [{ file: unit.relativePath, capability: "semantic" as const, input: { fileHash: preservedSemantic.fileHash, version: preservedSemantic.version, state: preservedSemantic.state, generation: generation.id, providerIdentity: preservedSemantic.providerIdentity, itemCount: preservedSemantic.itemCount, lastError: preservedSemantic.lastError } }] : []),
      ];
    });
    store.publishCandidateGeneration(generation.id, { requireGraph: true, requireLexical: true, semanticEnabled: semanticCandidate !== undefined || semanticPreserved, graphStaged: true, lexicalStaged: true, semanticStaged: semanticCandidate !== undefined || semanticPreserved, deletedFiles: plan.removedPaths, fileStates, versions: { graph: GRAPH_INDEX_VERSION, lexical: LEXICAL_INDEX_VERSION, ...(semanticCandidate ? { semantic: VECTOR_INDEX_VERSION } : {}) } });

    const totalMs = performance.now() - startedAt;
    const graphCurrent = operation === "sync" && plan.parsePaths.length === 0 && plan.removedPaths.length === 0;
    const lexicalRebuild = operation === "index" || storedLexicalVersion !== LEXICAL_INDEX_VERSION;
    const lexicalCurrent = graphCurrent && !lexicalRebuild;
    const legacy: LegacyIndexResult = {
      repoPath, repoId, operation, changeDetection: changes.changeDetection,
      changes: { addedFiles: changes.addedFiles, changedFiles: changes.changedFiles, deletedFiles: changes.deletedFiles, candidateFiles: changes.candidateFiles },
      graph: { repoPath, repoId, status: graphCurrent ? "current" : "indexed", version: GRAPH_INDEX_VERSION, versionChanged: !graphCurrent, fullRebuild: operation === "index", files: units.length, addedFiles: changes.addedFiles.length, changedFiles: changes.changedFiles.length, unchangedFiles: plan.reusePaths.length, deletedFiles: plan.removedPaths.length, impactedFiles: plan.resolvePaths.length, nodes: graph.graph.nodes.length, edges: graph.graph.edges.length, totalMs },
      lexical: { repoPath, repoId, status: lexicalCurrent ? "current" : "indexed", version: LEXICAL_INDEX_VERSION, versionChanged: !lexicalCurrent, fullRebuild: lexicalRebuild, files: units.length, indexedFiles: lexical.length, skippedFiles: plan.reusePaths.length, deletedFiles: plan.removedPaths.length, documents: lexical.reduce((sum, update) => sum + update.documents.length, 0), totalMs },
      semantic,
      totalMs,
    };
    const published = { kind: "published" as const, repositoryId: repoId, generationId: generation.id, plan, published: true as const, ...legacy };
    Object.defineProperty(published, "counters", {
      value: freezeIndexWorkCounters(counters),
      enumerable: false,
      writable: false,
      configurable: false,
    });
    return published as PublishedIndexRun & LegacyIndexResult;
  } catch (error) {
    return { kind: "failed", repositoryId: repoId, ...(activeGenerationId ? { activeGenerationId } : {}), published: false, failure: failure(error, activeGenerationId) };
  } finally {
    store.close();
  }
}

export function indexRepository(repoPath: string, options: IndexPipelineOptions = {}): Promise<IndexRunOutcome> { return runPipeline(repoPath, "index", options); }
export function syncRepository(repoPath: string, options: IndexPipelineOptions = {}): Promise<IndexRunOutcome> { return runPipeline(repoPath, "sync", options); }
export function migrateLegacyIndexOnMutation(repoPath: string, options: IndexPipelineOptions): Promise<IndexRunOutcome> {
  return runPipeline(repoPath, "sync", options);
}
