import { readTerminalDependency, isTerminalSpecifier, type TerminalDependency } from "./terminal-dependencies.js";
import fs from "node:fs/promises";
import { acquireIndexWriterLock } from "./index-writer-lock.js";
import path from "node:path";
import { createHash } from "node:crypto";

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
import { buildEmbeddingText } from "../semantic/embedding-text.js";
import type { CodeChunk } from "../graph/parsers/types.js";
import type { SemanticIndexResult } from "../semantic/semantic-index.service.js";
import { prepareSemanticCandidateFromFacts, type SemanticCandidate } from "../semantic/semantic-index.service.js";
import type { FactBlobKey } from "../facts/facts.types.js";
import type { ParsedFactsBlob } from "../facts/facts.types.js";
import type { SupportedLanguage } from "../graph/parsers/types.js";
import { AtlasStore } from "../../storage/atlas/atlas.store.js";
import { getRepositoryIdentity, canonicalRepositoryPath } from "../repository/repository-identity.js";
import { acquireFrameworkConfig } from "./framework-config-acquisition.js";
import { createFileHash } from "../repository/file-hash.js";
import { toLexicalDocumentsFromFacts } from "../lexical/lexical-index.service.js";
import { CURRENT_INDEX_VERSION_DOMAINS, RELIABILITY_VERSION } from "../repository/index-version.js";
import { buildCandidateSymbolBindings, rebindCandidateEdges } from "../graph/build-file-updates.js";
import { detectRepositoryChanges } from "./change-detector.js";
import { createCandidateGeneration } from "./index-manifest.js";
import { planInvalidation, requiresRepositoryResolution, type UnsafeTopologyReason } from "./invalidation-planner.js";
import { extractStableFacts, isIndexConfigPath, SourceRaceError, type SourceReader } from "./filesystem-change-detector.js";
import { createIndexWorkCounters, freezeIndexWorkCounters, recordIndexWork } from "./index-work-counters.js";
import { createCandidateResolutionInput } from "./resolution-scope.js";
import { createResolutionScope } from "./invalidation-planner.js";
import type { IndexPipelineOptions, IndexingChanges, IndexRunOutcome, IndexFailure, IndexedSourceUnit, IndexDiagnosticPhase, IndexDiagnosticTimings, PublishedIndexRun } from "./indexing.types.js";
import { materializeFrameworkConfig, type FrameworkConfigInput } from "../framework/framework-config.js";
import { analyzeFramework, builtinFrameworkAdapters, detectFrameworks, expandFrameworkAnalyzePaths } from "../framework/framework-registry.js";
import { planFrameworkInvalidation } from "../framework/framework-invalidation.js";
import type { FrameworkAnalysisContext, FrameworkConfigFact } from "../framework/framework.types.js";
import { frameworkMaterializationContributions } from "../reliability/reliability-incremental.js";
import { embeddingProviderIdentity, hasVectorStoreGeneration, semanticGenerationIdentity } from "../semantic/provider-identity.js";
import type { ScipBindingEvidence } from "../graph/resolver/scip-evidence.js";
import { scipBindingKey } from "../graph/resolver/scip-evidence.js";
import {
  computeScipFingerprint,
  SCIP_PROTOCOL_VERSION,
  SCIP_RESOLUTION_VERSION,
  SCIP_SCHEMA_VERSION,
} from "./scip-fingerprint.js";
import type { ScipIndexer, ScipIndexerStatus } from "./scip-indexer.types.js";
import { localScipIndexer } from "../../infrastructure/scip/local-scip-indexer.js";

const RESOLVER_BUDGETS = {
  candidateExpansions: 1000,
  bindingHops: 1000,
  returnDepth: 1000,
  inheritanceDepth: 1000,
  memberCandidates: 1000,
  expressionNodes: 1000,
  propagationRounds: 1000,
} as const;

export function frameworkChangedLookupKeys(
  previous: { dependencies: readonly { lookupKeys: readonly string[] }[] } | undefined,
  facts: readonly { relativePath: string; facts: ParsedFactsBlob }[],
  changes: Pick<IndexingChanges, "changedFiles" | "deletedFiles">,
  previousGraph?: Pick<CodeGraph, "nodes">,
): ReadonlySet<string> {
  const keys = new Set(changes.changedFiles);
  const names = new Set(
    facts
      .filter((unit) => changes.changedFiles.includes(unit.relativePath))
      .flatMap((unit) => [
        ...unit.facts.symbols.map((symbol) => symbol.name),
        ...(unit.facts.frameworkSyntax?.nodes ?? []).flatMap((node) => node.name ? [node.name] : []),
        ...unit.facts.parameters.flatMap((parameter) => parameter.typeText ? [parameter.typeText] : []),
      ]),
  );
  for (const node of previousGraph?.nodes ?? []) {
    if (changes.deletedFiles.includes(node.file)) names.add(node.name);
  }
  for (const dependency of previous?.dependencies ?? []) {
    for (const key of dependency.lookupKeys) {
      if ([...names].some((name) => key.endsWith(`:${name}`) || key.split(":").at(-1)?.split(".").at(-1) === name)) keys.add(key);
    }
  }
  return keys;
}

export function buildPipelineResolverContext(input: {
  generationId: string;
  repositoryIdentity: ReturnType<typeof getRepositoryIdentity>;
  facts: readonly ParsedFactsBlob[];
  adapters: readonly LanguageSemanticAdapter[];
  resolutionVersion: string;
  relativePaths?: readonly string[];
  scipEvidenceBySite?: ReadonlyMap<string, readonly ScipBindingEvidence[]>;
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
    scipEvidenceBySite: input.scipEvidenceBySite,
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
      ?? unit.facts.inheritances.find((site) => site.localId === decision.site.localId)?.range.startLine
      ?? unit.facts.implementations.find((site) => site.localId === decision.site.localId)?.range.startLine
      ?? unit.facts.references.find((site) => site.localId === decision.site.localId)?.range.startLine ?? 1;
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
    ?? unit.facts.inheritances.find((site) => site.localId === localId)?.range.startLine
    ?? unit.facts.implementations.find((site) => site.localId === localId)?.range.startLine
    ?? unit.facts.references.find((site) => site.localId === localId)?.range.startLine ?? 1;
}

function hasAmbiguousExports(units: readonly IndexedSourceUnit[], affected: ReadonlySet<string>): boolean {
  const namesByPath = new Map<string, Set<string>>();
  for (const unit of units) {
    const names = new Set<string>();
    for (const exportedName of unit.facts.exports.map((item) => item.exportedName).filter((name): name is string => Boolean(name) && name !== "*")) {
      if (names.has(exportedName) && affected.has(unit.relativePath)) return true;
      names.add(exportedName);
    }
    namesByPath.set(unit.relativePath, names);
  }

  for (const unit of units.filter((item) => affected.has(item.relativePath))) {
    const starSources = new Map<string, Set<string>>();
    const starSpecifiers = new Set([
      ...unit.facts.exports
        .filter((exportFact) => exportFact.kind === "star" && exportFact.moduleSpecifier)
        .map((exportFact) => exportFact.moduleSpecifier as string),
      ...[...unit.source.matchAll(/\bexport\s*\*\s+from\s+["']([^"']+)["']/g)].map((match) => match[1]!),
    ]);
    for (const moduleSpecifier of starSpecifiers) {
      for (const target of resolveImportCandidates(unit.relativePath, moduleSpecifier)) {
        for (const exportedName of namesByPath.get(target) ?? []) {
          const sources = starSources.get(exportedName) ?? new Set<string>();
          sources.add(target);
          starSources.set(exportedName, sources);
          if (sources.size > 1) return true;
        }
      }
    }
  }
  return false;
}

function addResolutionProvenance(
  graph: CodeGraph,
  units: readonly IndexedSourceUnit[],
  resolutions: ReadonlyMap<string, FactsGraphResolutionFile>,
  repoId: string,
  resolutionVersion: string,
  scipEvidenceById: ReadonlyMap<string, ScipBindingEvidence> = new Map(),
): void {
  const byIdentity = new Map(buildCandidateSymbolBindings(repoId, units, graph).map(({ identity, graphNodeId }) => [symbolIdentityKey(identity), graphNodeId] as const));
  for (const unit of units) {
    for (const decision of resolutions.get(unit.relativePath)?.decisions ?? []) {
      if (decision.status !== "resolved") continue;
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
      const evidence = decision.evidenceIds.map((evidenceId) => {
        const scip = scipEvidenceById.get(evidenceId);
        const line = scip?.range.startLine ?? sourceLine(unit, decision.site.localId);
        return { kind: scip ? "scip" : "resolver", sourceUnit: scip?.sourceUnit.relativePath ?? unit.relativePath, startLine: line, endLine: scip?.range.endLine ?? line, evidenceId };
      });
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
  const previousNodes = new Map(previousGraph.nodes.map((node) => [node.id, node]));
  const unchangedEdges = previousGraph.edges.filter((edge) => {
    if (edge.type !== "calls" && edge.type !== "references" && edge.type !== "extends" && edge.type !== "implements") return false;
    const previousFrom = previousNodes.get(edge.from);
    const previousTo = previousNodes.get(edge.to);
    return !resolvedPaths.has(previousFrom?.file ?? "") && !resolvedPaths.has(previousTo?.file ?? "");
  });
  const candidateSymbols = buildCandidateSymbolBindings(repoId, units, graph);
  const rebound = rebindCandidateEdges({ nodes: previousGraph.nodes, edges: unchangedEdges }, candidateSymbols, resolutionVersion);
  // Retain incomplete evidence only when unchanged endpoints still exist exactly.
  const nodeIds = new Set(graph.nodes.map((node) => node.id));
  const legacy = unchangedEdges.filter((edge) => edge.resolution === undefined && nodeIds.has(edge.from) && nodeIds.has(edge.to));
  const existing = new Set(graph.edges.map((edge) => `${edge.from}:${edge.to}:${edge.type}`));
  graph.edges.push(...[...rebound, ...legacy].filter((edge) => !existing.has(`${edge.from}:${edge.to}:${edge.type}`)));
  graph.edges = [...new Map(graph.edges.map((edge) => [`${edge.from}:${edge.to}:${edge.type}`, edge])).values()]
    .sort((left, right) => left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || left.type.localeCompare(right.type));
}

type LegacyIndexResult = {
  repoPath: string; repoId: string; operation: "index" | "sync" | "reindex"; changeDetection: "git" | "filesystem";
  changes: Pick<IndexingChanges, "addedFiles" | "changedFiles" | "deletedFiles" | "candidateFiles">;
  graph: { repoPath: string; repoId: string; status: "indexed" | "current"; storedVersion?: string; version: string; versionChanged: boolean; fullRebuild: boolean; files: number; addedFiles: number; changedFiles: number; unchangedFiles: number; deletedFiles: number; impactedFiles: number; nodes: number; edges: number; totalMs: number };
  lexical: { repoPath: string; repoId: string; status: "indexed" | "current"; version: string; versionChanged: boolean; fullRebuild: boolean; files: number; indexedFiles: number; skippedFiles: number; deletedFiles: number; documents: number; totalMs: number };
  semantic?: SemanticIndexResult; totalMs: number;
};

export type IndexPipelineResult = PublishedIndexRun & LegacyIndexResult & {
  frameworkConfig: readonly FrameworkConfigFact[];
  generationReused?: boolean;
};

const frameworkConfigKind = (relativePath: string): FrameworkConfigInput["kind"] | undefined => {
  const name = path.posix.basename(relativePath);
  if (name === "package.json") return "package";
  if (/^tsconfig(?:\.[^/]+)?\.json$/i.test(name)) return "tsconfig";
  if (/^jsconfig(?:\.[^/]+)?\.json$/i.test(name)) return "jsconfig";
  if (/^next\.config\.(js|mjs|ts)$/.test(name)) return "next";
  if (name === "pom.xml") return "maven";
  if (name === "build.gradle" || name === "build.gradle.kts") return "gradle";
  if (name === "pubspec.yaml") return "pubspec";
  return undefined;
};

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

const isScipConfig = (file: string): boolean => {
  const name = path.posix.basename(file);
  return name === "package.json" || /^(?:tsconfig|jsconfig).*\.json$/i.test(name);
};
const SCIP_LOCKFILE_NAMES = ["pnpm-lock.yaml", "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "bun.lock", "bun.lockb"] as const;

async function readScipLockfileHashes(repoPath: string): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();
  for (const name of SCIP_LOCKFILE_NAMES) {
    try {
      hashes.set(name, createHash("sha256").update(await fs.readFile(path.join(repoPath, name))).digest("hex"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A missing lockfile is represented by its absence in the fingerprint.
    }
  }
  return hashes;
}

async function scipInputsMatch(
  repoPath: string,
  units: readonly IndexedSourceUnit[],
  configHashes: ReadonlyMap<string, string>,
  lockfileHashes: ReadonlyMap<string, string>,
): Promise<boolean> {
  try {
    for (const unit of units) {
      if (unit.facts.language !== "typescript" && unit.facts.language !== "tsx" && unit.facts.language !== "javascript") continue;
      if (createFileHash(await fs.readFile(path.join(repoPath, unit.relativePath), "utf8")) !== unit.facts.contentHash) return false;
    }
    for (const [file, hash] of configHashes) {
      if (createFileHash(await fs.readFile(path.join(repoPath, file), "utf8")) !== hash) return false;
    }
    const currentLockfiles = await readScipLockfileHashes(repoPath);
    return JSON.stringify([...currentLockfiles]) === JSON.stringify([...lockfileHashes]);
  } catch {
    return false;
  }
}

function groupScipEvidence(evidence: readonly ScipBindingEvidence[]): ReadonlyMap<string, readonly ScipBindingEvidence[]> {
  const grouped = new Map<string, ScipBindingEvidence[]>();
  for (const binding of evidence) {
    const key = scipBindingKey(binding.sourceUnit, binding.siteLocalId);
    const values = grouped.get(key) ?? [];
    values.push(binding);
    grouped.set(key, values);
  }
  return new Map([...grouped].map(([key, values]) => [key, values.sort((left, right) => JSON.stringify(left.target).localeCompare(JSON.stringify(right.target)))]));
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

function createPhaseTimer(enabled: boolean, pipelineStartedAt: number): {
  start(phase: IndexDiagnosticPhase): void;
  finish(): void;
  record(phase: IndexDiagnosticPhase, elapsedMs: number): void;
  snapshot(): Readonly<IndexDiagnosticTimings> | undefined;
} {
  if (!enabled) return { start() {}, finish() {}, record() {}, snapshot: () => undefined };
  const timings: IndexDiagnosticTimings = {};
  let current: IndexDiagnosticPhase | undefined;
  let startedAt = 0;
  const finish = () => {
    if (current) timings[current] = (timings[current] ?? 0) + performance.now() - startedAt;
    current = undefined;
  };
  return {
    start(phase) { finish(); current = phase; startedAt = performance.now(); },
    finish,
    record(phase, elapsedMs) { timings[phase] = (timings[phase] ?? 0) + elapsedMs; },
    snapshot() {
      finish();
      const total = performance.now() - pipelineStartedAt;
      const measured = Object.entries(timings).filter(([phase]) => !["transactionCommit", "metadataFileStates", "generationPublish"].includes(phase)).reduce((sum, [, value]) => sum + value, 0);
      return { ...timings, total, unattributed: Math.max(0, total - measured) };
    },
  };
}

async function runPipelineLocked(inputPath: string, operation: "index" | "sync" | "reindex", options: IndexPipelineOptions): Promise<IndexRunOutcome> {
  const startedAt = performance.now();
  const repoPath = canonicalRepositoryPath(path.resolve(inputPath));
  const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
  const identity = getRepositoryIdentity(repoPath);
  const repoId = (store.findRepository(identity) ?? store.ensureRepository(identity)).id;
  const counters = createIndexWorkCounters();
  const phaseTimer = createPhaseTimer(options.diagnosticTimings === true, startedAt);
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
    const graphVersionChanged = store.getVersion(repoId, "graph") !== GRAPH_INDEX_VERSION;
    const capabilities = options.includeSemantic ? ["graph", "lexical", "semantic"] as const : ["graph", "lexical"] as const;
    const changes = await detectRepositoryChanges(repoPath, { store, repoId, capabilities: [...capabilities], versions: { graph: GRAPH_INDEX_VERSION, lexical: LEXICAL_INDEX_VERSION, semantic: VECTOR_INDEX_VERSION }, skipGit: options.skipGit, progress: options.progress, forceFullScan: operation === "reindex" || legacyRepository, onPhaseTiming: options.diagnosticTimings ? (phase, elapsedMs) => phaseTimer.record(phase, elapsedMs) : undefined });
    recordIndexWork(counters, "filesScanned", changes.relativeFiles.length);
    recordIndexWork(counters, "filesHashed", changes.fileHashes.size);
    const previousManifest = store.getGenerationManifest(repoId);
    const previousTerminals = store.getTerminalDependencies(repoId);
    const terminalDirtyOwners = new Set<string>();
    for (const previous of previousTerminals ?? []) {
      const current = await readTerminalDependency(repoPath, previous.ownerPath, previous.specifier);
      if (JSON.stringify(current) !== JSON.stringify(previous)) terminalDirtyOwners.add(previous.ownerPath);
    }
    const forceRebuild = operation === "reindex" || previousManifest === undefined || legacyRepository;
    const previousBindings = new Map(operation === "reindex" ? [] : previousManifest?.files.map((file) => [file.relativePath, file]) ?? []);
    const previousLexicalStates = store.getFileCapabilityStates(repoId, "lexical");
    const previousSemanticStates = store.getFileCapabilityStates(repoId, "semantic");
    const activeSemanticEnabled = store.hasActiveSemanticCapability(repoId);
    const lexicalFullRebuild = forceRebuild || storedLexicalVersion !== LEXICAL_INDEX_VERSION;
    const lexicalDirtyPaths = new Set(changes.relativeFiles.filter((file) => {
      const state = previousLexicalStates.get(file);
      return lexicalFullRebuild || state?.state !== "ready" || state.version !== LEXICAL_INDEX_VERSION || state.fileHash !== changes.fileHashes.get(file);
    }));
    const semanticProviderIdentity = options.semanticProviders ? embeddingProviderIdentity(options.semanticProviders.embeddingProvider) : undefined;
    const semanticFullRebuild = forceRebuild || store.getVersion(repoId, "semantic") !== VECTOR_INDEX_VERSION
      || [...previousSemanticStates.values()].some((state) => state.providerIdentity !== semanticProviderIdentity
        || !hasVectorStoreGeneration(state.generation, options.semanticProviders?.vectorStore.id ?? ""));
    const sourcePaths = changes.relativeFiles.filter((file) => getLanguageAdapter(file));
    const semanticDirtyPaths = new Set(sourcePaths.filter((file) => {
      const state = previousSemanticStates.get(file);
      return semanticFullRebuild || state?.state !== "ready" || state.fileHash !== changes.fileHashes.get(file);
    }));
    const semanticReusePaths = sourcePaths.filter((file) => !semanticDirtyPaths.has(file));
    const lexicalReusePaths = changes.relativeFiles.filter((file) => !lexicalDirtyPaths.has(file));

    const scipConfigHashes = new Map([...changes.fileHashes].filter(([file]) => isScipConfig(file)));
    let scipLockfileHashes = new Map<string, string>();
    let scipInputsReadable = true;
    try {
      scipLockfileHashes = await readScipLockfileHashes(repoPath);
    } catch {
      scipInputsReadable = false;
    }
    const scipSourceHashes = new Map([...changes.fileHashes].filter(([file]) => {
      const language = getLanguageAdapter(file)?.language;
      return language === "typescript" || language === "tsx" || language === "javascript";
    }));
    const scipRelevant = scipSourceHashes.size > 0;
    let discovery: Awaited<ReturnType<ScipIndexer["discover"]>> = { status: "unavailable" };
    if (scipRelevant) {
      try {
        discovery = await (options.scipIndexer ?? localScipIndexer).discover(repoPath);
      } catch (error) {
        discovery = { status: "failed", diagnostic: error instanceof Error ? error.message : String(error) };
      }
    }
    const scipStatusBeforeRun: ScipIndexerStatus = scipInputsReadable ? discovery.status : "failed";
    const scipFingerprint = computeScipFingerprint({
      repositoryId: repoId,
      sourceHashes: scipSourceHashes,
      configHashes: scipConfigHashes,
      lockfileHashes: scipLockfileHashes,
      toolVersion: discovery.tool?.version ?? null,
      scipSchemaVersion: SCIP_SCHEMA_VERSION,
      scipProtocolVersion: SCIP_PROTOCOL_VERSION,
      scipResolutionVersion: SCIP_RESOLUTION_VERSION,
      resolutionVersion: CURRENT_INDEX_VERSION_DOMAINS.resolutionVersion,
    });
    const preliminaryVersions = {
      ...CURRENT_INDEX_VERSION_DOMAINS,
      scipFingerprint,
      scipStatus: scipStatusBeforeRun,
    };
    const parserCompatible = sourcePaths.every((file) => {
      const binding = previousBindings.get(file), adapter = getLanguageAdapter(file)!;
      return !binding || binding.factBlobKey === factBlobKey({
        contentHash: binding.contentHash, language: adapter.language, parserIdentity: parserMetadata(adapter),
        factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion, factsSchemaVersion: CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion,
      });
    });
    const manifestInputsCompatible = previousBindings.size === sourcePaths.length
      && sourcePaths.every((file) => previousBindings.get(file)?.contentHash === changes.fileHashes.get(file));
    const activeGraph = store.loadGraph(repoId);
    const graphProvenanceComplete = !activeGraph.edges.some((edge) =>
      ["calls", "references", "extends", "implements"].includes(edge.type) && edge.resolution === undefined);
    const activeFramework = store.loadFramework(repoId);
    // Evidence completeness is independent of snapshot usability. Published
    // unsupported constructs stay incomplete and current until an input changes.
    let frameworkCompatible = false;
    if (activeGenerationId && activeFramework
      && activeFramework.frameworkResolutionVersion === CURRENT_INDEX_VERSION_DOMAINS.frameworkResolutionVersion) {
      try {
        store.assertCandidateFrameworkComplete(repoId, activeGenerationId, activeFramework.frameworkResolutionVersion);
        frameworkCompatible = true;
      } catch {
        // Missing/invalid materialization requires recovery, not no-op reuse.
      }
    }
    const versionCompatible = frameworkCompatible && graphProvenanceComplete && parserCompatible && previousManifest !== undefined && Object.entries(CURRENT_INDEX_VERSION_DOMAINS)
      .every(([key, value]) => previousManifest.versions[key as keyof typeof CURRENT_INDEX_VERSION_DOMAINS] === value)
      && previousManifest.versions.reliabilityVersion === RELIABILITY_VERSION
      && previousManifest.versions.scipFingerprint === scipFingerprint
      && previousManifest.versions.scipStatus === scipStatusBeforeRun;
    const semanticCompatible = !options.includeSemantic || (options.semanticProviders !== undefined
      && activeSemanticEnabled && !semanticFullRebuild && semanticDirtyPaths.size === 0
      && await options.semanticProviders.embeddingProvider.isAvailable()
      && await options.semanticProviders.vectorStore.isAvailable());
    if (!forceRebuild && !graphVersionChanged && scipInputsReadable && scipStatusBeforeRun !== "failed"
      && previousTerminals !== undefined && terminalDirtyOwners.size === 0
      && manifestInputsCompatible && versionCompatible && semanticCompatible && lexicalDirtyPaths.size === 0
      && changes.addedFiles.length === 0 && changes.changedFiles.length === 0 && changes.deletedFiles.length === 0) {
      for (const [relativePath, contentHash] of changes.fileHashes) {
        const kind = frameworkConfigKind(relativePath);
        if (kind) await acquireFrameworkConfig(repoPath, relativePath, kind, contentHash);
      }
      const graph = activeGraph;
      const plan = planInvalidation({ repositoryFiles: sourcePaths, currentFiles: new Map(sourcePaths.map((file) => [file, {
        contentHash: changes.fileHashes.get(file)!, language: getLanguageAdapter(file)!.language,
      }])), previousBindings, directImporters: new Map(), versions: preliminaryVersions, previousVersions: previousManifest!.versions });
      const totalMs = performance.now() - startedAt;
      const semantic = options.includeSemantic ? semanticResult(repoPath, repoId, "nothing-to-index", startedAt) : undefined;
      if (semantic) semantic.skippedFiles = sourcePaths.length;
      recordIndexWork(counters, "lexicalFilesReused", lexicalReusePaths.length);
      recordIndexWork(counters, "semanticFilesReused", activeSemanticEnabled ? sourcePaths.length : 0);
      recordIndexWork(counters, "frameworkFilesReused", sourcePaths.length);
      recordIndexWork(counters, "semanticUnitsReused", activeSemanticEnabled ? [...previousSemanticStates.values()].reduce((sum, state) => sum + state.itemCount, 0) : 0);
      recordIndexWork(counters, "scipReused");
      const reused = {
        kind: "published" as const, repositoryId: repoId, generationId: activeGenerationId!, published: true as const,
        generationReused: true, incrementalPlan: {
          graph: { mode: "reuse", dirtyPaths: [], reusedPaths: sourcePaths, reasons: [] },
          lexical: { mode: "reuse", dirtyPaths: [], reusedPaths: changes.relativeFiles, reasons: [] },
          semantic: { mode: "reuse", dirtyPaths: [], reusedPaths: activeSemanticEnabled ? sourcePaths : [], reasons: [] },
          framework: { mode: "reuse", dirtyPaths: [], reusedPaths: sourcePaths, reasons: [] },
          scip: { rerun: false, fingerprint: scipFingerprint, reasons: [] },
        }, plan, frameworkConfig: activeFramework!.config, repoPath, repoId, operation, changeDetection: changes.changeDetection,
        changes: { addedFiles: [], changedFiles: [], deletedFiles: [], candidateFiles: [] },
        graph: { repoPath, repoId, status: "current" as const, version: GRAPH_INDEX_VERSION, versionChanged: false, fullRebuild: false,
          files: sourcePaths.length, addedFiles: 0, changedFiles: 0, unchangedFiles: sourcePaths.length, deletedFiles: 0, impactedFiles: 0,
          nodes: graph.nodes.length, edges: graph.edges.length, totalMs },
        lexical: { repoPath, repoId, status: "current" as const, version: LEXICAL_INDEX_VERSION, versionChanged: false, fullRebuild: false,
          files: changes.relativeFiles.length, indexedFiles: 0, skippedFiles: changes.relativeFiles.length, deletedFiles: 0, documents: 0, totalMs },
        semantic, totalMs,
      };
      const timings = phaseTimer.snapshot();
      if (timings) Object.assign(reused, { phaseTimingsMs: timings });
      Object.defineProperty(reused, "counters", { value: freezeIndexWorkCounters(counters), enumerable: false });
      return reused as unknown as IndexPipelineResult;
    }
    const currentFiles = new Map<string, { contentHash: string; language: SupportedLanguage }>();
    const sources = new Map<string, string>();

    phaseTimer.start("parseFacts");
    for (const relativePath of changes.relativeFiles) {
      const adapter = getLanguageAdapter(relativePath);
      const contentHash = changes.fileHashes.get(relativePath);
      if (!adapter || !contentHash) continue;
      currentFiles.set(relativePath, { contentHash, language: adapter.language });
      sources.set(relativePath, await fs.readFile(path.join(repoPath, relativePath), "utf8"));
    }

    const frameworkConfigInputs: FrameworkConfigInput[] = [];
    for (const [relativePath, contentHash] of changes.fileHashes) {
      const kind = frameworkConfigKind(relativePath);
      if (!kind) continue;
      frameworkConfigInputs.push(await acquireFrameworkConfig(repoPath, relativePath, kind, contentHash));
    }
    const frameworkConfig = materializeFrameworkConfig(frameworkConfigInputs);

    const units: IndexedSourceUnit[] = [];
    const bindings: Array<{ repositoryId: string; relativePath: string; generationId: string; factBlobKey: FactBlobKey; contentHash: string; language: SupportedLanguage }> = [];

    let parsedFiles = 0;
    options.progress?.update?.(`Parsing repository — 0/${currentFiles.size}`);
    for (const [relativePath, current] of currentFiles) {
      let source = sources.get(relativePath);
      const adapter = getLanguageAdapter(relativePath);
      if (source === undefined || !adapter) continue;
      const parserIdentity = parserMetadata(adapter);
      const expected = { contentHash: current.contentHash, language: current.language, parserIdentity, factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion, factsSchemaVersion: CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion };
      let key = factBlobKey(expected);
      const cached = decodeFacts(operation === "reindex" ? undefined : store.getFactBlob(key), { key, ...expected });
      let facts;
      if (cached.kind === "hit") {
        if (createFileHash(source) !== cached.facts.contentHash) throw new SourceRaceError(relativePath);
        recordIndexWork(counters, "factCacheHits");
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
        try { store.putFactBlob(key, facts); recordIndexWork(counters, "storageTransactions"); } catch (error) { throw new CacheWriteFailure(`Fact cache write failed for ${relativePath}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      units.push({ relativePath, source, facts });
      bindings.push({ repositoryId: repoId, relativePath, generationId: "pending", factBlobKey: key, contentHash: facts.contentHash, language: current.language });
      parsedFiles += 1;
      options.progress?.update?.(`Parsing repository — ${parsedFiles}/${currentFiles.size}`);
    }
    phaseTimer.finish();

    phaseTimer.start("resolutionPreparation");
    const directImporters = new Map<string, Set<string>>();
    const addImporter = (target: string, importer: string) => {
      const importers = directImporters.get(target) ?? new Set<string>();
      importers.add(importer);
      directImporters.set(target, importers);
    };
    const previousGraph = activeGraph;
    const previousNodes = new Map(previousGraph.nodes.map((node) => [node.id, node]));
    for (const edge of previousGraph.edges) {
      if (edge.type === "contains") continue;
      const importer = previousNodes.get(edge.from)?.file;
      const target = previousNodes.get(edge.to)?.file;
      if (importer && target) addImporter(target, importer);
    }
    const currentFileSet = new Set(currentFiles.keys());
    const terminalDependencies: TerminalDependency[] = [];
    for (const unit of units) {
      const specifiers = new Set([
        ...unit.facts.imports.map((reference) => reference.moduleSpecifier),
        ...unit.facts.exports.flatMap((reference) => reference.moduleSpecifier ? [reference.moduleSpecifier] : []),
      ]);
      for (const moduleSpecifier of specifiers) {
        const targets = isRelativeImport(moduleSpecifier)
          ? resolveImportCandidates(unit.relativePath, moduleSpecifier)
          : [`module:${moduleSpecifier}`];
        const resolvedTarget = targets.find((target) => currentFileSet.has(target));
        if (resolvedTarget) {
          addImporter(resolvedTarget, unit.relativePath);
        } else if (isTerminalSpecifier(moduleSpecifier)) {
          const terminal = await readTerminalDependency(repoPath, unit.relativePath, moduleSpecifier);
          terminalDependencies.push(terminal);
          addImporter(terminal.state === "resolved" ? `terminal:${terminal.relativePath}` : `unresolved:${terminal.relativePath}`, unit.relativePath);
        } else {
          for (const target of targets) addImporter(target.startsWith("module:") ? target : `unresolved:${target}`, unit.relativePath);
        }
      }
    }
    const graphInputsChanged = forceRebuild || graphVersionChanged || !parserCompatible || changes.moduleConfigChanged === true
      || [...currentFiles].some(([file, current]) => previousBindings.get(file)?.contentHash !== current.contentHash)
      || [...previousBindings.keys()].some((file) => !currentFiles.has(file));
    const unsafeTopologyReasons = new Set<UnsafeTopologyReason>();
    if (changes.moduleConfigChanged) unsafeTopologyReasons.add("module_config_changed");
    const basePlan = planInvalidation({
      repositoryFiles: [...currentFiles.keys()], currentFiles, previousBindings, directImporters,
      additionalDirtyPaths: [...terminalDirtyOwners], unsafeTopologyReasons,
      versions: preliminaryVersions, previousVersions: operation === "reindex" ? undefined : previousManifest?.versions,
    });
    const relevantPaths = new Set([...basePlan.resolvePaths, ...basePlan.removedPaths]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const [target, importers] of directImporters) {
        if (currentFileSet.has(target) && !relevantPaths.has(target) && [...importers].some((file) => relevantPaths.has(file))) {
          relevantPaths.add(target); grew = true;
        }
      }
    }
    if (graphInputsChanged && store.getGraphResolutionDiagnostics(repoId).some((diagnostic) =>
      relevantPaths.has(diagnostic.source.file)
      && "reason" in diagnostic && diagnostic.reason !== undefined && /_(limit|overflow)$/.test(diagnostic.reason))) {
      unsafeTopologyReasons.add("dependency_provenance_incomplete");
    }
    if (graphInputsChanged && hasAmbiguousExports(units, relevantPaths)) unsafeTopologyReasons.add("export_ambiguous");
    if (previousGraph.edges.some((edge) =>
      (edge.type === "calls" || edge.type === "references" || edge.type === "extends" || edge.type === "implements") && edge.resolution === undefined
      && (relevantPaths.has(previousNodes.get(edge.from)?.file ?? "") || relevantPaths.has(previousNodes.get(edge.to)?.file ?? "")),
    )) unsafeTopologyReasons.add("dependency_provenance_incomplete");

    const makeInvalidationPlan = (versions: typeof preliminaryVersions) => planInvalidation({
      repositoryFiles: [...currentFiles.keys()], currentFiles, previousBindings, directImporters, unsafeTopologyReasons, additionalDirtyPaths: [...terminalDirtyOwners],
      versions, previousVersions: operation === "reindex" ? undefined : previousManifest?.versions,
    });
    const preliminaryPlan = makeInvalidationPlan(preliminaryVersions);
    let scipStatus: ScipIndexerStatus = scipStatusBeforeRun;
    let scipEvidence: readonly ScipBindingEvidence[] = [];
    const shouldRunScip = scipInputsReadable && discovery.status === "ready" && discovery.tool !== undefined && scipRelevant && (
      previousManifest === undefined
      || previousManifest.versions.scipFingerprint !== scipFingerprint
      || previousManifest.versions.scipStatus === "failed"
      || preliminaryPlan.fullGraphResolution
      || preliminaryPlan.resolvePaths.length > 0
    );
    if (shouldRunScip && discovery.tool) {
      recordIndexWork(counters, "scipRuns");
      phaseTimer.start("scipEnrichment");
      options.progress?.update?.("Enriching TypeScript/JavaScript bindings with SCIP");
      try {
        scipEvidence = await (options.scipIndexer ?? localScipIndexer).index({ projectRoot: repoPath, repositoryId: repoId, tool: discovery.tool, units });
        if (!await scipInputsMatch(repoPath, units, scipConfigHashes, scipLockfileHashes)) {
          scipEvidence = [];
          scipStatus = "failed";
        }
      } catch {
        scipEvidence = [];
        scipStatus = "failed";
      }
      phaseTimer.start("resolutionPreparation");
    }
    if (!shouldRunScip) recordIndexWork(counters, "scipReused");
    if (scipStatus !== "ready") options.progress?.update?.("SCIP enrichment unavailable; continuing with parser-based resolution");
    const versions = { ...preliminaryVersions, scipStatus };
    const plan = makeInvalidationPlan(versions);
    if (requiresRepositoryResolution(plan) || graphVersionChanged || !parserCompatible || operation === "reindex" || (previousManifest && previousManifest.versions.schemaVersion !== versions.schemaVersion)) {
      plan.fullGraphResolution = true;
      plan.resolvePaths = [...currentFiles.keys()].sort();
    }
    if (plan.fullGraphResolution) options.progress?.update?.(`Graph full fallback: ${operation === "reindex" ? "explicit reindex" : (graphVersionChanged ? "graph version changed" : !parserCompatible ? "parser identity changed" : plan.reasons.join(", ")) || "index compatibility"}`);

    recordIndexWork(counters, "importersInvalidated", plan.importersInvalidated.length);

    const generation = createCandidateGeneration(repoId, activeGenerationId, { ...versions, reliabilityVersion: RELIABILITY_VERSION }, bindings);
    store.beginCandidateGeneration(generation);
    store.writeCandidateManifest(generation.manifest);
    recordIndexWork(counters, "storageTransactions", 2);
    const scope = createResolutionScope(plan);
    const candidateInput = createCandidateResolutionInput(units, scope, activeGenerationId, previousGraph);
    const resolverContext = buildPipelineResolverContext({
      generationId: generation.id,
      repositoryIdentity: getRepositoryIdentity(repoPath),
      facts: candidateInput.allUnits.map((unit) => unit.facts),
      adapters: semanticAdapters,
      resolutionVersion: versions.resolutionVersion,
      relativePaths: candidateInput.allUnits.map((unit) => unit.relativePath),
      scipEvidenceBySite: groupScipEvidence(scipEvidence),
    });
    const graphCompatible = !requiresRepositoryResolution(plan)
      && plan.parsePaths.length === 0
      && plan.resolvePaths.length === 0
      && plan.removedPaths.length === 0
      && previousManifest !== undefined;
    phaseTimer.finish();
    const graph = graphCompatible
      ? { graph: structuredClone(previousGraph), resolutionByFile: new Map() }
      : await (options.progress
        ? options.progress.run(
          "Resolving language relationships",
          (progressReporter) => buildCodeGraphWithResolutionFromFacts(repoPath, candidateInput.allUnits, progressReporter, repoId, candidateInput.scope.paths, resolverContext, options.diagnosticTimings ? (phase, elapsedMs) => phaseTimer.record(phase, elapsedMs) : undefined),
        )
        : buildCodeGraphWithResolutionFromFacts(repoPath, candidateInput.allUnits, undefined, repoId, candidateInput.scope.paths, resolverContext, options.diagnosticTimings ? (phase, elapsedMs) => phaseTimer.record(phase, elapsedMs) : undefined));
    if (graphCompatible) {
      graph.graph.edges = graph.graph.edges.filter((edge) => edge.type !== "calls" && edge.type !== "references" && edge.type !== "extends" && edge.type !== "implements");
      rebindUnchangedSemanticEdges(graph.graph, previousGraph, candidateInput.allUnits, repoId, resolverContext.resolutionVersion, new Set());
    } else {
      const scipEvidenceById = new Map(scipEvidence.map((item) => [item.evidenceId, item] as const));
      addResolutionProvenance(graph.graph, candidateInput.allUnits, graph.resolutionByFile, repoId, resolverContext.resolutionVersion, scipEvidenceById);
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
    const reuseResolutionPaths = plan.reasons.some((reason) => reason === "resolution_version_changed" || reason === "scip_fingerprint_changed" || reason === "scip_status_changed") ? [] : plan.reusePaths;
    phaseTimer.start("graphPersistence");
    const graphWrites = graphCompatible
      ? store.copyActiveGraphToCandidate(generation.id)
      : store.writeCandidateGraph(generation.id, graph.graph, changes.fileHashes, persistedResolution, reuseResolutionPaths,
        [...candidateInput.scope.paths, ...plan.removedPaths]);
    recordIndexWork(counters, "graphRowsCopied", graphWrites.symbolsCopied + graphWrites.edgesCopied);
    if ("symbolsInserted" in graphWrites) recordIndexWork(counters, "graphRowsInserted", graphWrites.symbolsInserted + graphWrites.edgesInserted);
    recordIndexWork(counters, "storageTransactions", graphWrites.transactions);
    phaseTimer.record("transactionCommit", graphWrites.transactionCommitMs);
    phaseTimer.finish();
    options.progress?.update?.("Resolving framework relationships");
    const frameworkFacts = candidateInput.allUnits.map((unit) => ({ relativePath: unit.relativePath, facts: unit.facts }));
    const frameworkContextBase = {
      repositoryId: repoId,
      facts: frameworkFacts,
      graph: graph.graph,
      config: frameworkConfig,
    };
    const previousFramework = activeFramework;
    const changedConfigPaths = new Set([...changes.addedFiles, ...changes.changedFiles, ...changes.deletedFiles].filter((file) => frameworkConfig.some((item) => item.relativePath === file) || previousFramework?.config.some((item) => item.relativePath === file)));
    const changedInputKeys = new Set([
      ...(previousFramework?.config ?? []).filter((item) => changedConfigPaths.has(item.relativePath)).map((item) => item.inputKey),
      ...frameworkConfig.filter((item) => changedConfigPaths.has(item.relativePath)).map((item) => item.inputKey),
    ]);
    const frameworkInvalidation = planFrameworkInvalidation({
      paths: [...new Set([...changes.addedFiles, ...changes.changedFiles, ...changes.deletedFiles, ...terminalDirtyOwners])],
      allPaths: [...new Set([...currentFiles.keys(), ...changes.deletedFiles])],
      changedInputKeys,
      changedLookupKeys: frameworkChangedLookupKeys(previousFramework, frameworkFacts, changes, previousGraph),
      previous: previousFramework,
      frameworkResolutionVersion: CURRENT_INDEX_VERSION_DOMAINS.frameworkResolutionVersion!,
      topologyComplete: !requiresRepositoryResolution(plan) && operation !== "reindex",
    });
    if (frameworkInvalidation.widened) options.progress?.update?.(`Framework full fallback: ${frameworkInvalidation.reasons.join(", ")}`);
    const frameworkAnalyzePaths = expandFrameworkAnalyzePaths(previousFramework, new Set(frameworkInvalidation.analyzePaths));
    recordIndexWork(counters, "frameworkFilesResolved", frameworkAnalyzePaths.size);
    recordIndexWork(counters, "frameworkFilesReused", Math.max(0, frameworkInvalidation.reusePaths.length - Math.max(0, frameworkAnalyzePaths.size - frameworkInvalidation.analyzePaths.length)));
    phaseTimer.start("frameworkDetection");
    const detections = detectFrameworks(frameworkContextBase, builtinFrameworkAdapters);
    phaseTimer.finish();
    phaseTimer.start("frameworkMaterialization");
    const frameworkMaterialization = frameworkAnalyzePaths.size === 0 && previousFramework
      ? { ...previousFramework, generationId: generation.id }
      : analyzeFramework({
      ...frameworkContextBase,
      generationId: generation.id,
      frameworkResolutionVersion: CURRENT_INDEX_VERSION_DOMAINS.frameworkResolutionVersion!,
      detections,
      analyzePaths: frameworkAnalyzePaths,
      previousFramework,
      maxObservations: 10_000,
    } satisfies FrameworkAnalysisContext, builtinFrameworkAdapters);
    phaseTimer.finish();
    phaseTimer.start("frameworkPersistence");
    if (frameworkAnalyzePaths.size === 0 && previousFramework) {
      const frameworkWrites = store.copyActiveFrameworkToCandidate(generation.id);
      recordIndexWork(counters, "frameworkRowsCopied", frameworkWrites.rowsCopied);
      recordIndexWork(counters, "storageTransactions", frameworkWrites.transactions);
      phaseTimer.record("transactionCommit", frameworkWrites.transactionCommitMs);
    }
    else {
      const frameworkWrites = store.writeCandidateFramework(generation.id, frameworkMaterialization);
      const reliabilityWrites = store.stageReliabilityContributions(generation.id, frameworkMaterializationContributions(frameworkMaterialization));
      recordIndexWork(counters, "frameworkRowsInserted", frameworkWrites.entitiesInserted + frameworkWrites.relationshipsInserted + frameworkWrites.classificationsInserted + frameworkWrites.diagnosticsInserted + frameworkWrites.coverageInserted + frameworkWrites.stateRowsWritten + reliabilityWrites.contributionsInserted);
      recordIndexWork(counters, "storageTransactions", frameworkWrites.transactions + reliabilityWrites.transactions);
      phaseTimer.record("transactionCommit", frameworkWrites.transactionCommitMs + reliabilityWrites.transactionCommitMs);
    }
    phaseTimer.finish();
    if (versions.frameworkResolutionVersion) store.assertCandidateFrameworkComplete(repoId, generation.id, versions.frameworkResolutionVersion);
    options.progress?.update?.("Writing index results");
    phaseTimer.start("lexicalBuild");
    const lexical: LexicalFileUpdate[] = units.filter((unit) => lexicalDirtyPaths.has(unit.relativePath)).map((unit) => ({ file: unit.relativePath, fileHash: unit.facts.contentHash, documents: toLexicalDocumentsFromFacts(repoId, unit) }));
    phaseTimer.finish();
    phaseTimer.start("lexicalPersistence");
    for (const file of lexicalDirtyPaths) {
      if (!getLanguageAdapter(file)) lexical.push({ file, fileHash: changes.fileHashes.get(file)!, documents: [] });
    }
    const lexicalCopy = store.copyActiveLexicalToCandidate(generation.id, lexicalReusePaths);
    const lexicalWrites = store.writeCandidateLexicalDocuments(generation.id, lexical);
    recordIndexWork(counters, "lexicalDocumentsReused", lexicalCopy.documentsCopied);
    recordIndexWork(counters, "lexicalDocumentsInserted", lexicalWrites.documentsInserted);
    recordIndexWork(counters, "lexicalDocumentsDeleted", lexicalWrites.documentsDeleted);
    recordIndexWork(counters, "storageTransactions", lexicalCopy.transactions + lexicalWrites.transactions);
    phaseTimer.record("transactionCommit", lexicalCopy.transactionCommitMs + lexicalWrites.transactionCommitMs);
    recordIndexWork(counters, "lexicalFilesUpdated", lexical.length);
    recordIndexWork(counters, "lexicalFilesReused", lexicalReusePaths.length);
    phaseTimer.finish();
    const semanticStartedAt = performance.now();
    let semantic: SemanticIndexResult | undefined;
    let semanticPreserved = false;
    let semanticFailure: string | undefined;
    const preserveSemantic = () => {
      const copied = store.copyActiveSemanticVectorsToCandidate(generation.id);
      recordIndexWork(counters, "semanticVectorsCopied", copied.vectorsCopied);
      recordIndexWork(counters, "storageTransactions", copied.transactions);
      phaseTimer.record("transactionCommit", copied.transactionCommitMs);
    };
    if (options.includeSemantic || activeSemanticEnabled) phaseTimer.start("semanticBuild");
    if (options.includeSemantic) {
      const providers = options.semanticProviders;
      if (!providers) {
        if (activeSemanticEnabled) {
          semanticFailure = "Semantic provider is not configured while an active semantic capability exists.";
          preserveSemantic();
          semanticPreserved = true;
          semantic = semanticResult(repoPath, repoId, "unavailable", semanticStartedAt, undefined, semanticFailure);
        } else semantic = semanticResult(repoPath, repoId, "not-configured", semanticStartedAt);
      } else {
        try {
          const available = await providers.embeddingProvider.isAvailable() && await providers.vectorStore.isAvailable();
          if (!available) {
            if (activeSemanticEnabled) {
              semanticFailure = "Semantic provider is unavailable while an active semantic capability exists.";
              preserveSemantic();
              semanticPreserved = true;
              semantic = semanticResult(repoPath, repoId, "unavailable", semanticStartedAt, undefined, semanticFailure);
            } else semantic = semanticResult(repoPath, repoId, "unavailable", semanticStartedAt);
          } else {
            if (semanticFullRebuild) options.progress?.update?.(`Semantic full fallback: ${operation === "reindex" ? "explicit reindex" : forceRebuild ? "initial build" : "provider, vector-store or version identity changed"}`);
            const dirtyUnits = units.filter((unit) => semanticDirtyPaths.has(unit.relativePath));
            const reusableVectors = new Map<string, readonly number[]>();
            if (!semanticFullRebuild) {
              for (const point of store.getActiveSemanticPoints(repoId, dirtyUnits.map((unit) => unit.relativePath))) {
                const payload = point.payload;
                if (typeof payload.file !== "string" || typeof payload.content !== "string"
                  || typeof payload.symbolName !== "string" || typeof payload.symbolType !== "string" || typeof payload.language !== "string") continue;
                const chunk = { content: payload.content, symbolName: payload.symbolName, symbolType: payload.symbolType, language: payload.language } as CodeChunk;
                if (point.vector.length === providers.embeddingProvider.dimensions && point.vector.every(Number.isFinite)) {
                  reusableVectors.set(buildEmbeddingText(payload.file, chunk), point.vector);
                }
              }
            }
            semanticCandidate = await prepareSemanticCandidateFromFacts(repoId, generation.id, dirtyUnits, providers.embeddingProvider, providers.vectorStore, reusableVectors);
            const semanticCopy = store.copyActiveSemanticVectorsToCandidate(generation.id, semanticReusePaths);
            recordIndexWork(counters, "semanticVectorsCopied", semanticCopy.vectorsCopied);
            recordIndexWork(counters, "storageTransactions", semanticCopy.transactions);
            phaseTimer.record("transactionCommit", semanticCopy.transactionCommitMs);
            recordIndexWork(counters, "semanticFilesEmbedded", dirtyUnits.length);
            recordIndexWork(counters, "semanticFilesReused", semanticReusePaths.length);
            recordIndexWork(counters, "semanticUnitsEmbedded", semanticCandidate.embeddedSymbols);
            recordIndexWork(counters, "semanticUnitsReused", semanticCandidate.points.length - semanticCandidate.embeddedSymbols
              + semanticReusePaths.reduce((sum, file) => sum + (previousSemanticStates.get(file)?.itemCount ?? 0), 0));
            semantic = semanticResult(repoPath, repoId, "indexed", semanticStartedAt, semanticCandidate);
            semantic.fullReindex = semanticFullRebuild;
            semantic.skippedFiles = semanticReusePaths.length;
          }
        } catch (error) {
          semanticFailure = error instanceof Error ? error.message : String(error);
          if (activeSemanticEnabled) {
            preserveSemantic();
            semanticPreserved = true;
          }
          semantic = semanticResult(repoPath, repoId, "unavailable", semanticStartedAt, undefined, semanticFailure);
        }
      }
    } else if (activeSemanticEnabled) {
      preserveSemantic();
      semanticPreserved = true;
    }
    phaseTimer.finish();
    if (semanticCandidate) {
      phaseTimer.start("semanticPersistence");
      const semanticWrites = store.writeCandidateSemanticVectors(generation.id, semanticCandidate.points);
      phaseTimer.record("transactionCommit", semanticWrites.transactionCommitMs);
      recordIndexWork(counters, "semanticVectorsWritten", semanticCandidate.points.length);
      recordIndexWork(counters, "storageTransactions");
    }
    if (options.includeSemantic || activeSemanticEnabled) phaseTimer.finish();
    phaseTimer.start("publishFinalize");
    const configFileStates = [...changes.fileHashes.entries()]
      .filter(([file]) => isIndexConfigPath(file))
      .map(([file, fileHash]) => ({
        file,
        capability: "graph" as const,
        input: { fileHash, version: GRAPH_INDEX_VERSION, state: "ready" as const, generation: generation.id, itemCount: 0 },
      }));
    const nonParserStates = changes.relativeFiles.filter((file) => !getLanguageAdapter(file)).flatMap((file) => [
      { file, capability: "graph" as const, input: { fileHash: changes.fileHashes.get(file)!, version: GRAPH_INDEX_VERSION, state: "ready" as const, generation: generation.id, itemCount: 0 } },
      { file, capability: "lexical" as const, input: { fileHash: changes.fileHashes.get(file)!, version: LEXICAL_INDEX_VERSION, state: "ready" as const, generation: generation.id, itemCount: 0 } },
    ]);
    const fileStates = [...configFileStates, ...nonParserStates, ...units.flatMap((unit) => {
      const graphCount = graph.graph.nodes.filter((node) => node.file === unit.relativePath).length;
      const lexicalCount = lexical.find((update) => update.file === unit.relativePath)?.documents.length ?? previousLexicalStates.get(unit.relativePath)?.itemCount ?? 0;
      const semanticCount = semanticDirtyPaths.has(unit.relativePath)
        ? semanticCandidate?.points.filter((point) => point.payload.file === unit.relativePath).length ?? 0
        : previousSemanticStates.get(unit.relativePath)?.itemCount ?? 0;
      const preservedSemantic = previousSemanticStates?.get(unit.relativePath);
      return [
        { file: unit.relativePath, capability: "graph" as const, input: { fileHash: unit.facts.contentHash, version: GRAPH_INDEX_VERSION, state: "ready" as const, generation: generation.id, itemCount: graphCount } },
        { file: unit.relativePath, capability: "lexical" as const, input: { fileHash: unit.facts.contentHash, version: LEXICAL_INDEX_VERSION, state: "ready" as const, generation: generation.id, itemCount: lexicalCount } },
        ...(semanticCandidate ? [{ file: unit.relativePath, capability: "semantic" as const, input: {
          fileHash: unit.facts.contentHash,
          version: VECTOR_INDEX_VERSION,
          state: "ready" as const,
          generation: !semanticDirtyPaths.has(unit.relativePath) && previousSemanticStates.get(unit.relativePath)?.generation
            ? previousSemanticStates.get(unit.relativePath)!.generation!
            : semanticGenerationIdentity(
            unit.facts.contentHash,
            semanticCandidate.providerIdentity,
            options.semanticProviders!.vectorStore.id,
            previousSemanticStates.get(unit.relativePath)?.providerIdentity,
            previousSemanticStates.has(unit.relativePath),
          ),
          providerIdentity: semanticCandidate.providerIdentity,
          itemCount: semanticCount,
        } }] : []),
        ...(!semanticCandidate && preservedSemantic ? [{ file: unit.relativePath, capability: "semantic" as const, input: {
          fileHash: preservedSemantic.fileHash,
          version: preservedSemantic.version,
          state: semanticFailure ? "error" as const : preservedSemantic.state,
          generation: preservedSemantic.generation,
          providerIdentity: preservedSemantic.providerIdentity,
          itemCount: preservedSemantic.itemCount,
          lastError: semanticFailure ?? preservedSemantic.lastError,
        } }] : []),
      ];
    })];
    const deletedFiles = [...new Set([
      ...plan.removedPaths,
      ...changes.deletedFiles,
    ])];
    for (const terminal of terminalDependencies) {
      if (JSON.stringify(await readTerminalDependency(repoPath, terminal.ownerPath, terminal.specifier)) !== JSON.stringify(terminal)) throw new SourceRaceError(terminal.relativePath);
    }
    const publication = store.publishCandidateGeneration(generation.id, { requireGraph: true, requireLexical: true, terminalDependencies, semanticEnabled: semanticCandidate !== undefined || semanticPreserved, graphStaged: true, frameworkStaged: true, reliabilityStaged: true, lexicalStaged: true, semanticStaged: semanticCandidate !== undefined || semanticPreserved, deletedFiles, fileStates, versions: { graph: GRAPH_INDEX_VERSION, lexical: LEXICAL_INDEX_VERSION, ...(semanticCandidate ? { semantic: VECTOR_INDEX_VERSION } : {}) } });
    phaseTimer.record("metadataFileStates", publication.metadataFileStatesMs);
    phaseTimer.record("generationPublish", publication.generationPublishMs);
    phaseTimer.record("transactionCommit", publication.transactionCommitMs);
    recordIndexWork(counters, "storageTransactions", publication.transactions);
    recordIndexWork(counters, "metadataRowsUpdated", publication.metadataRowsUpdated);
    recordIndexWork(counters, "metadataRowsDeleted", publication.metadataRowsDeleted);

    const totalMs = performance.now() - startedAt;
    const graphCurrent = graphCompatible;
    const lexicalRebuild = lexicalFullRebuild;
    const lexicalCurrent = lexicalDirtyPaths.size === 0 && !lexicalRebuild && changes.deletedFiles.length === 0;
    const legacy: LegacyIndexResult = {
      repoPath, repoId, operation, changeDetection: changes.changeDetection,
      changes: { addedFiles: changes.addedFiles, changedFiles: changes.changedFiles, deletedFiles: changes.deletedFiles, candidateFiles: changes.candidateFiles },
      graph: { repoPath, repoId, status: graphCurrent ? "current" : "indexed", version: GRAPH_INDEX_VERSION, versionChanged: !graphCurrent, fullRebuild: forceRebuild, files: units.length, addedFiles: changes.addedFiles.length, changedFiles: changes.changedFiles.length, unchangedFiles: plan.reusePaths.length, deletedFiles: plan.removedPaths.length, impactedFiles: plan.resolvePaths.length, nodes: graph.graph.nodes.length, edges: graph.graph.edges.length, totalMs },
      lexical: { repoPath, repoId, status: lexicalCurrent ? "current" : "indexed", version: LEXICAL_INDEX_VERSION, versionChanged: !lexicalCurrent, fullRebuild: lexicalRebuild, files: units.length, indexedFiles: lexical.length, skippedFiles: lexicalReusePaths.length, deletedFiles: changes.deletedFiles.length, documents: lexical.reduce((sum, update) => sum + update.documents.length, 0), totalMs },
      semantic,
      totalMs,
    };
    const incrementalPlan = {
      graph: { mode: graphCompatible ? "reuse" as const : plan.fullGraphResolution ? "full" as const : "delta" as const,
        dirtyPaths: graphCompatible ? [] : candidateInput.scope.paths,
        reusedPaths: sourcePaths.filter((file) => !candidateInput.scope.paths.includes(file)), reasons: plan.reasons },
      lexical: { mode: lexicalCurrent ? "reuse" as const : lexicalFullRebuild ? "full" as const : "delta" as const,
        dirtyPaths: [...lexicalDirtyPaths], reusedPaths: lexicalReusePaths,
        reasons: lexicalFullRebuild ? [forceRebuild ? "initial_or_explicit_rebuild" : "lexical_version_changed"] : [] },
      semantic: { mode: !semanticCandidate ? "reuse" as const : semanticFullRebuild ? "full" as const : "delta" as const,
        dirtyPaths: semanticCandidate ? [...semanticDirtyPaths] : [], reusedPaths: semanticCandidate ? semanticReusePaths : sourcePaths,
        reasons: semanticFailure ? [semanticFailure] : semanticFullRebuild && semanticCandidate ? [forceRebuild ? "initial_or_explicit_rebuild" : "semantic_identity_changed"] : [] },
      framework: { mode: frameworkAnalyzePaths.size === 0 ? "reuse" as const : frameworkInvalidation.widened ? "full" as const : "delta" as const,
        dirtyPaths: [...frameworkAnalyzePaths], reusedPaths: frameworkInvalidation.reusePaths.filter((file) => !frameworkAnalyzePaths.has(file)), reasons: frameworkInvalidation.reasons },
      scip: { rerun: shouldRunScip, fingerprint: scipFingerprint, reasons: shouldRunScip ? ["scip_inputs_or_compatibility_changed"] : [] },
    };
    const published = { incrementalPlan, kind: "published" as const, repositoryId: repoId, generationId: generation.id, plan, published: true as const, frameworkConfig, ...legacy };
    const finalTimings = phaseTimer.snapshot();
    if (finalTimings) Object.assign(published, { phaseTimingsMs: finalTimings });
    Object.defineProperty(published, "counters", {
      value: freezeIndexWorkCounters(counters),
      enumerable: false,
      writable: false,
      configurable: false,
    });
    return published as unknown as IndexPipelineResult;
  } catch (error) {
    const phaseTimingsMs = phaseTimer.snapshot();
    return { kind: "failed", repositoryId: repoId, ...(activeGenerationId ? { activeGenerationId } : {}), published: false, failure: failure(error, activeGenerationId), ...(phaseTimingsMs ? { phaseTimingsMs } : {}) };
  } finally {
    store.close();
  }
}

async function runPipeline(inputPath: string, operation: "index" | "sync" | "reindex", options: IndexPipelineOptions): Promise<IndexRunOutcome> {
  try {
    const release = await acquireIndexWriterLock(inputPath);
    try { return await runPipelineLocked(inputPath, operation, options); }
    finally { await release(); }
  } catch (error) {
    const repositoryId = getRepositoryIdentity(inputPath).id;
    return { kind: "failed", repositoryId, published: false, failure: failure(error) };
  }
}

export function indexRepository(repoPath: string, options: IndexPipelineOptions = {}): Promise<IndexRunOutcome> { return runPipeline(repoPath, "index", options); }
export function syncRepository(repoPath: string, options: IndexPipelineOptions = {}): Promise<IndexRunOutcome> { return runPipeline(repoPath, "sync", options); }
export function migrateLegacyIndexOnMutation(repoPath: string, options: IndexPipelineOptions): Promise<IndexRunOutcome> {
  return runPipeline(repoPath, "sync", options);
}

export function reindexRepository(repoPath: string, options: IndexPipelineOptions = {}): Promise<IndexRunOutcome> { return runPipeline(repoPath, "reindex", options); }
