import fs from "node:fs/promises";
import path from "node:path";

import { GRAPH_INDEX_VERSION, LEXICAL_INDEX_VERSION, VECTOR_INDEX_VERSION } from "../../config/constants.js";
import { decodeFacts } from "../facts/facts-codec.js";
import { extractParsedFacts } from "../facts/facts-extractor.js";
import { factBlobKey } from "../facts/facts-identity.js";
import { buildCodeGraphWithResolutionFromFacts } from "../graph/build-graph.js";
import { parserMetadata } from "../graph/parsers/code-parser.js";
import { getLanguageAdapter } from "../graph/parsers/registry.js";
import type { LexicalFileUpdate } from "../../storage/atlas/atlas.types.js";
import type { SemanticIndexResult } from "../semantic/semantic-index.service.js";
import { AtlasStore } from "../../storage/atlas/atlas.store.js";
import { getRepositoryIdentity, canonicalRepositoryPath } from "../repository/repository-identity.js";
import { toLexicalDocumentsFromFacts } from "../lexical/lexical-index.service.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../repository/index-version.js";
import { detectRepositoryChanges } from "./change-detector.js";
import { createCandidateGeneration } from "./index-manifest.js";
import { planInvalidation } from "./invalidation-planner.js";
import type { IndexPipelineOptions, IndexingChanges, IndexRunOutcome, IndexFailure, IndexedSourceUnit } from "./indexing.types.js";

type LegacyIndexResult = {
  repoPath: string; repoId: string; operation: "index" | "sync"; changeDetection: "git" | "filesystem";
  changes: Pick<IndexingChanges, "addedFiles" | "changedFiles" | "deletedFiles" | "candidateFiles">;
  graph: { repoPath: string; repoId: string; status: "indexed" | "current"; storedVersion?: string; version: string; versionChanged: boolean; fullRebuild: boolean; files: number; addedFiles: number; changedFiles: number; unchangedFiles: number; deletedFiles: number; impactedFiles: number; nodes: number; edges: number; totalMs: number };
  lexical: { repoPath: string; repoId: string; status: "indexed" | "current"; version: string; versionChanged: boolean; fullRebuild: boolean; files: number; indexedFiles: number; skippedFiles: number; deletedFiles: number; documents: number; totalMs: number };
  semantic?: SemanticIndexResult; totalMs: number;
};

export type IndexPipelineResult = LegacyIndexResult;

function failure(error: unknown, activeGenerationId?: string): IndexFailure {
  return { kind: "infrastructure_failure", message: error instanceof Error ? error.message : String(error), ...(activeGenerationId ? { activeGenerationId } : {}) };
}

async function runPipeline(inputPath: string, operation: "index" | "sync", options: IndexPipelineOptions): Promise<IndexPipelineResult> {
  const startedAt = performance.now();
  const repoPath = canonicalRepositoryPath(path.resolve(inputPath));
  const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
  const repoId = store.ensureRepository(getRepositoryIdentity(repoPath)).id;
  let activeGenerationId = store.getActiveGenerationId(repoId);

  try {
    const storedLexicalVersion = store.getVersion(repoId, "lexical");
    const capabilities = options.includeSemantic ? ["graph", "lexical", "semantic"] as const : ["graph", "lexical"] as const;
    const changes = await detectRepositoryChanges(repoPath, { store, repoId, capabilities: [...capabilities], versions: { graph: GRAPH_INDEX_VERSION, lexical: LEXICAL_INDEX_VERSION, semantic: VECTOR_INDEX_VERSION }, skipGit: options.skipGit, progress: options.progress, forceFullScan: operation === "index" });
    const previousManifest = store.getGenerationManifest(repoId);
    const previousBindings = new Map(previousManifest?.files.map((file) => [file.relativePath, file]) ?? []);
    const currentFiles = new Map<string, { contentHash: string; language: "typescript" | "tsx" | "javascript" }>();
    const sources = new Map<string, string>();

    for (const relativePath of changes.relativeFiles) {
      const adapter = getLanguageAdapter(relativePath);
      const contentHash = changes.fileHashes.get(relativePath);
      if (!adapter || !contentHash) continue;
      currentFiles.set(relativePath, { contentHash, language: adapter.language });
      sources.set(relativePath, await fs.readFile(path.join(repoPath, relativePath), "utf8"));
    }

    const plan = planInvalidation({ repositoryFiles: [...currentFiles.keys()], currentFiles, previousBindings, directImporters: new Map(), versions: CURRENT_INDEX_VERSION_DOMAINS, previousVersions: previousManifest?.versions });
    const units: IndexedSourceUnit[] = [];
    const bindings: Array<{ repositoryId: string; relativePath: string; generationId: string; factBlobKey: any; contentHash: string; language: "typescript" | "tsx" | "javascript" }> = [];

    for (const [relativePath, current] of currentFiles) {
      const source = sources.get(relativePath);
      const adapter = getLanguageAdapter(relativePath);
      if (!source || !adapter) continue;
      const parserIdentity = parserMetadata(adapter);
      const expected = { contentHash: current.contentHash, language: current.language, parserIdentity, factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion, factsSchemaVersion: CURRENT_INDEX_VERSION_DOMAINS.schemaVersion };
      const key = factBlobKey(expected);
      const cached = decodeFacts(store.getFactBlob(key), { key, ...expected });
      let facts;
      if (cached.kind === "hit") {
        facts = cached.facts;
      } else {
        const extracted = extractParsedFacts({ source, language: current.language, contentHash: current.contentHash, factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion, factsSchemaVersion: CURRENT_INDEX_VERSION_DOMAINS.schemaVersion });
        if (extracted.kind !== "facts") throw extracted.error;
        facts = extracted.facts;
        try { store.putFactBlob(key, facts); } catch (error) { throw new Error(`Fact cache write failed for ${relativePath}: ${error instanceof Error ? error.message : String(error)}`); }
      }
      units.push({ relativePath, source, facts });
      bindings.push({ repositoryId: repoId, relativePath, generationId: "pending", factBlobKey: key, contentHash: current.contentHash, language: current.language });
    }

    const generation = createCandidateGeneration(repoId, activeGenerationId, CURRENT_INDEX_VERSION_DOMAINS, bindings);
    store.beginCandidateGeneration(generation);
    store.writeCandidateManifest(generation.manifest);
    const graph = await buildCodeGraphWithResolutionFromFacts(repoPath, units, undefined, repoId);
    store.writeCandidateGraph(generation.id, graph.graph, changes.fileHashes);
    const lexical: LexicalFileUpdate[] = units.map((unit) => ({ file: unit.relativePath, fileHash: unit.facts.contentHash, documents: toLexicalDocumentsFromFacts(repoId, unit) }));
    store.writeCandidateLexicalDocuments(generation.id, lexical);
    store.publishCandidateGeneration(generation.id, { requireGraph: true, requireLexical: true, semanticEnabled: false });
    for (const unit of units) {
      store.setFileCapabilityState(repoId, unit.relativePath, "graph", { fileHash: unit.facts.contentHash, version: GRAPH_INDEX_VERSION, state: "ready", generation: generation.id, itemCount: graph.graph.nodes.filter((node) => node.file === unit.relativePath).length });
      store.setFileCapabilityState(repoId, unit.relativePath, "lexical", { fileHash: unit.facts.contentHash, version: LEXICAL_INDEX_VERSION, state: "ready", generation: generation.id, itemCount: toLexicalDocumentsFromFacts(repoId, unit).length });
    }
    store.setVersion(repoId, "graph", GRAPH_INDEX_VERSION);
    store.setVersion(repoId, "lexical", LEXICAL_INDEX_VERSION);
    store.deleteUnreferencedFactBlobs();

    const totalMs = performance.now() - startedAt;
    const graphCurrent = operation === "sync" && plan.parsePaths.length === 0 && plan.removedPaths.length === 0;
    const lexicalRebuild = operation === "index" || storedLexicalVersion !== LEXICAL_INDEX_VERSION;
    const lexicalCurrent = graphCurrent && !lexicalRebuild;
    const legacy: LegacyIndexResult = {
      repoPath, repoId, operation, changeDetection: changes.changeDetection,
      changes: { addedFiles: changes.addedFiles, changedFiles: changes.changedFiles, deletedFiles: changes.deletedFiles, candidateFiles: changes.candidateFiles },
      graph: { repoPath, repoId, status: graphCurrent ? "current" : "indexed", version: GRAPH_INDEX_VERSION, versionChanged: !graphCurrent, fullRebuild: operation === "index", files: units.length, addedFiles: changes.addedFiles.length, changedFiles: changes.changedFiles.length, unchangedFiles: plan.reusePaths.length, deletedFiles: plan.removedPaths.length, impactedFiles: plan.resolvePaths.length, nodes: graph.graph.nodes.length, edges: graph.graph.edges.length, totalMs },
      lexical: { repoPath, repoId, status: lexicalCurrent ? "current" : "indexed", version: LEXICAL_INDEX_VERSION, versionChanged: !lexicalCurrent, fullRebuild: lexicalRebuild, files: units.length, indexedFiles: lexical.length, skippedFiles: plan.reusePaths.length, deletedFiles: plan.removedPaths.length, documents: lexical.reduce((sum, update) => sum + update.documents.length, 0), totalMs },
      totalMs,
    };
    return { kind: "published", repositoryId: repoId, generationId: generation.id, plan, published: true, ...legacy } as IndexPipelineResult;
  } catch (error) {
    return { kind: "failed", repositoryId: repoId, ...(activeGenerationId ? { activeGenerationId } : {}), published: false, failure: failure(error, activeGenerationId) } as unknown as IndexPipelineResult;
  } finally {
    store.close();
  }
}

export function indexRepository(repoPath: string, options: IndexPipelineOptions = {}): Promise<IndexPipelineResult> { return runPipeline(repoPath, "index", options); }
export function syncRepository(repoPath: string, options: IndexPipelineOptions = {}): Promise<IndexPipelineResult> { return runPipeline(repoPath, "sync", options); }
