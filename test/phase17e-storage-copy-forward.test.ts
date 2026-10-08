import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { factBlobKey } from "../src/core/facts/facts-identity.js";
import type { ParsedFactsBlob } from "../src/core/facts/facts.types.js";
import { createCandidateGeneration } from "../src/core/indexing/index-manifest.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

const versions = {
  schemaVersion: "3",
  factsSchemaVersion: "facts-1",
  factsVersion: "facts-1",
  resolutionVersion: "resolution-1",
  derivedVersion: "derived-1",
};

function facts(hash: string): ParsedFactsBlob {
  return {
    factsSchemaVersion: "facts-1",
    factsVersion: "facts-1",
    contentHash: hash,
    language: "typescript",
    parserIdentity: { language: "typescript", runtimeName: "test", runtimeVersion: "1", packageName: "test", grammarName: "test", grammarVersion: "1" },
    parseStatus: "complete",
    parserDiagnostics: [], symbols: [], containmentScopes: [], imports: [], exports: [], references: [], callSites: [], bindingSeeds: [],
    declaredTypeAnnotations: [], expressions: [], members: [], assignments: [], parameters: [], returns: [], constructors: [],
    inheritances: [], implementations: [], aliases: [], modules: [], namespaces: [],
  };
}

function vector(repoId: string, id: string, file: string) {
  return { id, vector: [1, 0], payload: { repoId, file, fileHash: id, content: id } };
}

async function withStore(run: (store: AtlasStore, repositoryId: string) => void): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase17e-storage-"));
  const store = new AtlasStore(path.join(root, "atlas.db"));
  const repository = store.ensureRepository(getRepositoryIdentity(path.join(root, "repo")));
  try {
    run(store, repository.id);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

function addBindings(store: AtlasStore, generation: ReturnType<typeof createCandidateGeneration>, repositoryId: string, paths: string[]): void {
  const files = paths.map((relativePath) => {
    const blob = facts(`hash:${relativePath}`);
    const key = factBlobKey(blob);
    store.putFactBlob(key, blob);
    return { repositoryId, relativePath, generationId: generation.id, factBlobKey: key, contentHash: blob.contentHash, language: "typescript" as const };
  });
  store.writeCandidateManifest({ ...generation.manifest, files });
}

test("copies only selected lexical files into a candidate generation", async () => withStore((store, repositoryId) => {
  const first = createCandidateGeneration(repositoryId, undefined, versions, []);
  store.beginCandidateGeneration(first);
  store.writeCandidateManifest(first.manifest);
  store.writeCandidateLexicalDocuments(first.id, [
    { file: "keep.ts", fileHash: "keep", documents: [{ documentId: "keep", file: "keep.ts", content: "retained token" }] },
    { file: "changed.ts", fileHash: "old", documents: [{ documentId: "changed-old", file: "changed.ts", content: "obsolete token" }] },
  ]);
  store.publishCandidateGeneration(first.id, { requireLexical: true });

  const second = createCandidateGeneration(repositoryId, first.id, versions, []);
  store.beginCandidateGeneration(second);
  store.writeCandidateManifest(second.manifest);
  store.copyActiveLexicalToCandidate(second.id, ["keep.ts"]);
  store.writeCandidateLexicalDocuments(second.id, [
    { file: "changed.ts", fileHash: "new", documents: [{ documentId: "changed-new", file: "changed.ts", content: "replacement token" }] },
  ]);
  store.publishCandidateGeneration(second.id, { requireLexical: true });

  assert.deepEqual(store.searchLexical(repositoryId, "retained", 10).map(({ file }) => file), ["keep.ts"]);
  assert.deepEqual(store.searchLexical(repositoryId, "replacement", 10).map(({ file }) => file), ["changed.ts"]);
  assert.deepEqual(store.searchLexical(repositoryId, "obsolete", 10), []);
}));

test("semantic copy-forward can restrict reuse to unchanged paths", async () => withStore((store, repositoryId) => {
  const first = createCandidateGeneration(repositoryId, undefined, versions, []);
  store.beginCandidateGeneration(first);
  addBindings(store, first, repositoryId, ["keep.ts", "changed.ts"]);
  store.writeCandidateSemanticVectors(first.id, [vector(repositoryId, "keep", "keep.ts"), vector(repositoryId, "changed", "changed.ts")]);
  store.publishCandidateGeneration(first.id, { semanticEnabled: true });

  const second = createCandidateGeneration(repositoryId, first.id, versions, []);
  store.beginCandidateGeneration(second);
  addBindings(store, second, repositoryId, ["keep.ts", "changed.ts"]);
  store.copyActiveSemanticVectorsToCandidate(second.id, ["keep.ts"]);
  store.publishCandidateGeneration(second.id, { semanticEnabled: true });

  assert.equal(store.countSemanticVectors(repositoryId), 1);
  assert.equal(store.searchSemanticVectors(repositoryId, [1, 0], 10)[0]?.payload.content, "keep");
}));

test("semantic copy-forward keeps its candidate-binding default when no paths are passed", async () => withStore((store, repositoryId) => {
  const first = createCandidateGeneration(repositoryId, undefined, versions, []);
  store.beginCandidateGeneration(first);
  addBindings(store, first, repositoryId, ["a.ts", "b.ts"]);
  store.writeCandidateSemanticVectors(first.id, [vector(repositoryId, "a", "a.ts"), vector(repositoryId, "b", "b.ts")]);
  store.publishCandidateGeneration(first.id, { semanticEnabled: true });

  const second = createCandidateGeneration(repositoryId, first.id, versions, []);
  store.beginCandidateGeneration(second);
  addBindings(store, second, repositoryId, ["a.ts"]);
  store.copyActiveSemanticVectorsToCandidate(second.id);
  store.publishCandidateGeneration(second.id, { semanticEnabled: true });

  assert.equal(store.countSemanticVectors(repositoryId), 1);
  assert.equal(store.searchSemanticVectors(repositoryId, [1, 0], 10)[0]?.payload.content, "a");
}));

test("copies the active graph into a graph-compatible candidate", async () => withStore((store, repositoryId) => {
  const first = createCandidateGeneration(repositoryId, undefined, versions, []);
  store.beginCandidateGeneration(first);
  store.writeCandidateManifest(first.manifest);
  const graph = {
    nodes: [
      { id: "source", type: "function" as const, name: "run", file: "src/run.ts", qualifiedName: undefined, startLine: undefined, endLine: undefined },
      { id: "target", type: "function" as const, name: "target", file: "src/target.ts", qualifiedName: undefined, startLine: undefined, endLine: undefined },
    ],
    edges: [{ from: "source", to: "target", type: "calls" as const }],
  };
  store.writeCandidateGraph(first.id, graph, new Map());
  store.publishCandidateGeneration(first.id, { requireGraph: true });

  const second = createCandidateGeneration(repositoryId, first.id, versions, []);
  store.beginCandidateGeneration(second);
  store.writeCandidateManifest(second.manifest);
  store.copyActiveGraphToCandidate(second.id);
  store.publishCandidateGeneration(second.id, { requireGraph: true });

  assert.deepEqual(store.loadGraph(repositoryId), graph);
}));

test("graph delta reuses exact clean partitions and keeps deletion and renamed targets correct", async () => withStore((store, repositoryId) => {
  const first = createCandidateGeneration(repositoryId, undefined, versions, []);
  store.beginCandidateGeneration(first);
  store.writeCandidateManifest(first.manifest);
  store.writeCandidateGraph(first.id, {
    nodes: [
      { id: "a", type: "function", name: "a", file: "a.ts" },
      { id: "b-old", type: "function", name: "b", file: "b.ts" },
      { id: "removed", type: "function", name: "removed", file: "gone.ts" },
      { id: "c", type: "function", name: "c", file: "c.ts" },
      { id: "d", type: "function", name: "d", file: "d.ts" },
    ],
    edges: [
      { from: "a", to: "b-old", type: "calls", resolutionMethod: "symbol" },
      { from: "a", to: "removed", type: "calls" },
      { from: "c", to: "a", type: "calls", confidence: 0.4 },
      { from: "d", to: "c", type: "calls", resolutionMethod: "symbol", evidenceKind: "EXTRACTED", confidence: 1, resolutionSource: { file: "d.ts", line: 5 } },
    ],
  }, new Map());
  store.publishCandidateGeneration(first.id, { requireGraph: true });

  const second = createCandidateGeneration(repositoryId, first.id, versions, []);
  store.beginCandidateGeneration(second);
  store.writeCandidateManifest(second.manifest);
  const candidateGraph = {
    nodes: [
      { id: "a", type: "function", name: "a", file: "a.ts", qualifiedName: undefined, startLine: undefined, endLine: undefined },
      { id: "b-new", type: "function", name: "b", file: "b.ts", qualifiedName: undefined, startLine: undefined, endLine: undefined },
      { id: "c", type: "function", name: "c", file: "c.ts", qualifiedName: undefined, startLine: undefined, endLine: undefined },
      { id: "d", type: "function", name: "d", file: "d.ts", qualifiedName: undefined, startLine: undefined, endLine: undefined },
    ],
    edges: [
      { from: "a", to: "b-new", type: "calls" as const },
      { from: "c", to: "a", type: "calls" as const, confidence: 0.9 },
      { from: "d", to: "c", type: "calls" as const, resolutionMethod: "symbol", evidenceKind: "EXTRACTED" as const, confidence: 1, resolutionSource: { file: "d.ts", line: 5 } },
    ],
  };
  const stats = store.writeCandidateGraph(second.id, candidateGraph, new Map(), undefined, [], ["b.ts", "gone.ts"]);
  store.publishCandidateGeneration(second.id, { requireGraph: true });

  assert.deepEqual(store.loadGraph(repositoryId), candidateGraph);
  const { transactionCommitMs, ...counts } = stats;
  assert.deepEqual(counts, {
    symbolsInserted: 1,
    edgesInserted: 2,
    symbolsCopied: 3,
    edgesCopied: 1,
    resolutionRowsCopied: 0,
    transactions: 1,
  });
  assert.ok(transactionCommitMs >= 0);
}));

test("reads semantic points only for requested dirty paths", async () => withStore((store, repositoryId) => {
  const generation = createCandidateGeneration(repositoryId, undefined, versions, []);
  store.beginCandidateGeneration(generation);
  store.writeCandidateManifest(generation.manifest);
  store.writeCandidateSemanticVectors(generation.id, [vector(repositoryId, "a", "a.ts"), vector(repositoryId, "b", "b.ts")]);
  store.publishCandidateGeneration(generation.id, { semanticEnabled: true });

  const points = store.getActiveSemanticPoints(repositoryId, ["b.ts", "b.ts"]);
  assert.deepEqual(points.map(({ id, payload }) => [id, payload.file]), [["b", "b.ts"]]);
  assert.deepEqual(points[0]?.vector, [1, 0]);
}));

test("generation publication reports metadata and commit timing counters", async () => withStore((store, repositoryId) => {
  const first = createCandidateGeneration(repositoryId, undefined, versions, []);
  store.beginCandidateGeneration(first);
  store.writeCandidateManifest(first.manifest);
  store.publishCandidateGeneration(first.id, {
    fileStates: [
      { file: "keep.ts", capability: "graph", input: { fileHash: "keep-1", version: "graph-1", state: "ready", itemCount: 1 } },
      { file: "removed.ts", capability: "graph", input: { fileHash: "remove", version: "graph-1", state: "ready", itemCount: 1 } },
    ],
    versions: { graph: "graph-1" },
  });

  const second = createCandidateGeneration(repositoryId, first.id, versions, []);
  store.beginCandidateGeneration(second);
  store.writeCandidateManifest(second.manifest);
  const stats = store.publishCandidateGeneration(second.id, {
    deletedFiles: ["removed.ts"],
    fileStates: [{ file: "keep.ts", capability: "graph", input: { fileHash: "keep-2", version: "graph-2", state: "ready", itemCount: 2 } }],
    versions: { graph: "graph-2" },
  });

  assert.equal(stats?.transactions, 1);
  assert.equal(stats?.metadataRowsUpdated, 3);
  assert.equal(stats?.metadataRowsDeleted, 2);
  assert.ok((stats?.metadataFileStatesMs ?? -1) >= 0);
  assert.ok((stats?.generationPublishMs ?? -1) >= 0);
  assert.ok((stats?.transactionCommitMs ?? -1) >= 0);
}));

test("copies framework evidence and reliability rows into a framework-compatible candidate", async () => withStore((store, repositoryId) => {
  const first = createCandidateGeneration(repositoryId, undefined, versions, []);
  store.beginCandidateGeneration(first);
  store.writeCandidateManifest(first.manifest);
  const framework = {
    frameworkResolutionVersion: "framework-1", entities: [], relationships: [], classifications: [], diagnostics: [],
    coverage: [], config: [], detections: [], dependencies: [], complete: true,
  };
  const frameworkWrite = store.writeCandidateFramework(first.id, framework);
  const contribution = {
    ownerKey: "src/run.ts",
    scope: { scopeKey: "framework:test", capability: "test", framework: "test" },
    outputKey: "route:/",
    outcome: "accepted" as const,
    complete: true,
    stale: false,
    origin: "framework_inferred" as const,
    evidence: [],
    diagnostics: [],
    coverage: { applicable: true, supported: true, attempted: true, resolved: true, ambiguous: false, unknown: false, unsupported: false, budgetExhausted: false },
  };
  const reliabilityWrite = store.stageReliabilityContributions(first.id, [contribution]);
  assert.equal(frameworkWrite?.transactions, 1);
  assert.ok((frameworkWrite?.transactionCommitMs ?? -1) >= 0);
  assert.equal(reliabilityWrite?.contributionsInserted, 1);
  assert.ok((reliabilityWrite?.transactionCommitMs ?? -1) >= 0);
  store.publishCandidateGeneration(first.id, { frameworkStaged: true });

  const second = createCandidateGeneration(repositoryId, first.id, versions, []);
  store.beginCandidateGeneration(second);
  store.writeCandidateManifest(second.manifest);
  store.copyActiveFrameworkToCandidate(second.id);
  store.publishCandidateGeneration(second.id, { frameworkStaged: true });

  assert.deepEqual(store.loadFramework(repositoryId), { ...framework, repositoryId, generationId: second.id });
  assert.deepEqual(store.loadReliabilityContributions(repositoryId), [contribution]);
}));
