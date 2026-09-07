import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { factBlobKey } from "../src/core/facts/facts-identity.js";
import type { ParsedFactsBlob } from "../src/core/facts/facts.types.js";
import { createCandidateGeneration } from "../src/core/indexing/index-manifest.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

const versions = {
  schemaVersion: "2",
  factsVersion: "1",
  resolutionVersion: "1",
  derivedVersion: "1",
};

function graph(file: string, name: string) {
  return {
    nodes: [{ id: `${file}:${name}`, type: "function" as const, name, file }],
    edges: [],
  };
}

function facts(contentHash: string): ParsedFactsBlob {
  return {
    factsSchemaVersion: "1",
    factsVersion: "1",
    contentHash,
    language: "typescript",
    parserIdentity: {
      language: "typescript",
      parserName: "tree-sitter",
      parserVersion: "0.25.1",
      grammarName: "tree-sitter-typescript",
      grammarVersion: "0.23.2",
      adapterVersion: "1",
    },
    parseStatus: "complete",
    parserDiagnostics: [],
    symbols: [],
    containmentScopes: [],
    imports: [],
    exports: [],
    references: [],
    callSites: [],
    bindingSeeds: [],
    declaredTypeAnnotations: [],
  };
}

function point(repoId: string, id: string, file: string): { id: string; vector: number[]; payload: Record<string, string> } {
  return { id, vector: [1, 0], payload: { repoId, file, fileHash: id, content: id } };
}

test("candidate graph and manifest stay invisible until atomic publication", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-generation-"));
  const repoPath = path.join(root, "repo");
  const databasePath = path.join(root, "atlas.db");

  try {
    await writeFile(path.join(root, "seed.txt"), "test");
    const store = new AtlasStore(databasePath);
    const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
    const first = createCandidateGeneration(repository.id, undefined, versions, []);
    store.beginCandidateGeneration(first);
    store.writeCandidateManifest(first.manifest);
    store.writeCandidateGraph(first.id, graph("a.ts", "old"), new Map([["a.ts", "hash-a"]]));
    store.publishCandidateGeneration(first.id);

    assert.equal(store.getActiveGenerationId(repository.id), first.id);
    assert.equal(store.loadGraph(repository.id).nodes[0]?.name, "old");

    const second = createCandidateGeneration(repository.id, first.id, versions, []);
    store.beginCandidateGeneration(second);
    store.writeCandidateManifest(second.manifest);
    store.writeCandidateGraph(second.id, graph("b.ts", "new"), new Map([["b.ts", "hash-b"]]));

    assert.equal(store.getActiveGenerationId(repository.id), first.id);
    assert.equal(store.loadGraph(repository.id).nodes[0]?.name, "old");
    assert.deepEqual(store.getGenerationManifest(repository.id)?.generationId, first.id);

    store.publishCandidateGeneration(second.id);
    assert.equal(store.getActiveGenerationId(repository.id), second.id);
    assert.equal(store.loadGraph(repository.id).nodes[0]?.name, "new");
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed candidate leaves the active generation and candidate unreadable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-generation-failure-"));
  const repoPath = path.join(root, "repo");
  const databasePath = path.join(root, "atlas.db");

  try {
    const store = new AtlasStore(databasePath);
    const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
    const candidate = createCandidateGeneration(repository.id, undefined, versions, []);
    store.beginCandidateGeneration(candidate);
    store.writeCandidateManifest(candidate.manifest);
    store.writeCandidateGraph(candidate.id, graph("candidate.ts", "candidate"), new Map([["candidate.ts", "hash"]]));
    assert.throws(() => store.publishCandidateGeneration(candidate.id, { requireGraph: true, requireLexical: true }));
    assert.equal(store.getActiveGenerationId(repository.id), undefined);
    assert.deepEqual(store.loadGraph(repository.id), { nodes: [], edges: [] });
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active semantic readers isolate v2 rows and retain legacy fallback without v2 state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-semantic-read-"));
  const databasePath = path.join(root, "atlas.db");

  try {
    const store = new AtlasStore(databasePath);
    const legacyRepository = store.ensureRepository(getRepositoryIdentity(path.join(root, "legacy")));
    const activeRepository = store.ensureRepository(getRepositoryIdentity(path.join(root, "active")));
    store.ensureSemanticVectorDimensions(2);
    store.upsertSemanticVectors([point(legacyRepository.id, "legacy", "legacy.ts"), point(activeRepository.id, "legacy", "legacy.ts")]);

    const generation = createCandidateGeneration(activeRepository.id, undefined, versions, []);
    store.beginCandidateGeneration(generation);
    store.writeCandidateManifest(generation.manifest);
    store.writeCandidateSemanticVectors(generation.id, [point(activeRepository.id, "v2", "active.ts")]);
    store.publishCandidateGeneration(generation.id, { semanticEnabled: true });

    assert.equal(store.countSemanticVectors(activeRepository.id), 1);
    assert.equal(store.searchSemanticVectors(activeRepository.id, [1, 0], 10)[0]?.payload.content, "v2");

    const emptyGeneration = createCandidateGeneration(activeRepository.id, generation.id, versions, []);
    store.beginCandidateGeneration(emptyGeneration);
    store.writeCandidateManifest(emptyGeneration.manifest);
    store.publishCandidateGeneration(emptyGeneration.id);

    assert.equal(store.countSemanticVectors(legacyRepository.id), 1);
    assert.equal(store.countSemanticVectors(activeRepository.id), 0);
    assert.deepEqual(store.searchSemanticVectors(activeRepository.id, [1, 0], 10), []);
    assert.deepEqual(store.getSemanticIndexedFileStates(activeRepository.id), new Map());
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("active lexical reads preserve filePrefix filtering", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-lexical-prefix-"));
  const databasePath = path.join(root, "atlas.db");

  try {
    const store = new AtlasStore(databasePath);
    const repository = store.ensureRepository(getRepositoryIdentity(path.join(root, "repo")));
    const generation = createCandidateGeneration(repository.id, undefined, versions, []);
    store.beginCandidateGeneration(generation);
    store.writeCandidateManifest(generation.manifest);
    store.writeCandidateLexicalDocuments(generation.id, [
      { file: "src/a.ts", fileHash: "a", documents: [{ documentId: "a", file: "src/a.ts", content: "needle" }] },
      { file: "src/b.ts", fileHash: "b", documents: [{ documentId: "b", file: "src/b.ts", content: "needle" }] },
    ]);
    store.publishCandidateGeneration(generation.id, { requireLexical: true });

    assert.deepEqual(store.searchLexical(repository.id, "needle", 10, "src/a").map((row) => row.file), ["src/a.ts"]);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fact-blob GC derives global references without a caller generation argument", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-fact-gc-"));
  const databasePath = path.join(root, "atlas.db");

  try {
    const store = new AtlasStore(databasePath);
    const repository = store.ensureRepository(getRepositoryIdentity(path.join(root, "repo")));
    const secondRepository = store.ensureRepository(getRepositoryIdentity(path.join(root, "second-repo")));
    const keptFacts = facts("kept");
    const orphanFacts = facts("orphan");
    const keptKey = factBlobKey(keptFacts);
    const orphanKey = factBlobKey(orphanFacts);
    store.putFactBlob(keptKey, keptFacts);
    store.putFactBlob(orphanKey, orphanFacts);
    const generation = createCandidateGeneration(repository.id, undefined, versions, [{
      repositoryId: repository.id,
      relativePath: "kept.ts",
      generationId: "placeholder",
      factBlobKey: keptKey,
      contentHash: keptFacts.contentHash,
      language: keptFacts.language,
    }]);
    store.beginCandidateGeneration(generation);
    store.writeCandidateManifest(generation.manifest);
    store.publishCandidateGeneration(generation.id);

    const secondGeneration = createCandidateGeneration(secondRepository.id, undefined, versions, [{
      repositoryId: secondRepository.id,
      relativePath: "shared.ts",
      generationId: "placeholder",
      factBlobKey: keptKey,
      contentHash: keptFacts.contentHash,
      language: keptFacts.language,
    }]);
    store.beginCandidateGeneration(secondGeneration);
    store.writeCandidateManifest(secondGeneration.manifest);
    store.publishCandidateGeneration(secondGeneration.id);

    const historicalGeneration = createCandidateGeneration(repository.id, generation.id, versions, []);
    store.beginCandidateGeneration(historicalGeneration);
    store.writeCandidateManifest(historicalGeneration.manifest);
    store.publishCandidateGeneration(historicalGeneration.id);

    assert.equal(store.deleteUnreferencedFactBlobs(), 1);
    assert.equal(store.getFactBlob(keptKey) !== undefined, true);
    assert.equal(store.getFactBlob(orphanKey), undefined);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
