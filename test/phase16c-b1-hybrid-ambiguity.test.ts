import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCandidateGeneration } from "../src/core/indexing/index-manifest.js";
import type { EmbeddingProvider } from "../src/core/semantic/embedding-provider.js";
import type { VectorStore } from "../src/core/semantic/vector-store.js";
import { inspectHybridSearch } from "../src/core/retrieval/hybrid-search.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

const versions = {
  schemaVersion: "2",
  factsSchemaVersion: "1",
  factsVersion: "1",
  resolutionVersion: "1",
  derivedVersion: "1",
};

type Document = {
  documentId: string;
  file: string;
  symbolName?: string;
  qualifiedName?: string;
  symbolType?: string;
  content: string;
  startLine?: number;
  endLine?: number;
};

async function withGeneration<T>(
  documents: Document[],
  run: (root: string, repoId: string) => Promise<T>,
): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-b1-hybrid-"));
  await mkdir(path.join(root, ".codeatlas"), { recursive: true });
  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
  const repoId = store.ensureRepository(getRepositoryIdentity(root)).id;
  const generation = createCandidateGeneration(repoId, undefined, versions, []);
  store.beginCandidateGeneration(generation);
  store.writeCandidateManifest(generation.manifest);
  const byFile = new Map<string, Document[]>();
  for (const document of documents) {
    const entries = byFile.get(document.file) ?? [];
    entries.push(document);
    byFile.set(document.file, entries);
  }
  store.writeCandidateLexicalDocuments(generation.id, [...byFile].map(([file, entries]) => ({
    file,
    fileHash: file,
    documents: entries,
  })));
  store.publishCandidateGeneration(generation.id, { requireLexical: true });
  store.close();
  try {
    return await run(root, repoId);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function ambiguityDocuments(order: { targetA: string; targetB: string }): Document[] {
  return [
    { documentId: "exact-a", file: order.targetA, symbolName: "load", qualifiedName: "load", symbolType: "function", content: "target-A" },
    { documentId: "exact-b", file: order.targetB, symbolName: "load", qualifiedName: "load", symbolType: "function", content: "target-B" },
    { documentId: "partial", file: "src/c-partial.ts", symbolName: "loadHelper", content: "partial load" },
    { documentId: "content", file: "src/d-content.ts", symbolName: "reader", content: "load content" },
  ];
}

test("hybrid shares RRF rank across explicit ambiguous lexical ties and preserves later positions", async () => {
  await withGeneration(ambiguityDocuments({ targetA: "src/a.ts", targetB: "src/b.ts" }), async (root) => {
    const result = await inspectHybridSearch("load", 10, root, { semanticState: "not_configured" });
    const exact = result.fusedResults.filter((item) => item.symbolName === "load");
    const byFile = Object.fromEntries(exact.map((item) => [item.file!, item]));

    assert.equal(result.lexicalResults[0]?.lexicalRankGroup, result.lexicalResults[1]?.lexicalRankGroup);
    assert.ok(result.lexicalResults[0]?.lexicalRankGroup);
    assert.equal(result.lexicalResults[2]?.lexicalRankGroup, undefined);
    assert.equal(byFile["src/a.ts"]?.lexicalRank, 1);
    assert.equal(byFile["src/b.ts"]?.lexicalRank, 1);
    assert.equal(byFile["src/a.ts"]?.fusionScore, 1 / 61);
    assert.equal(byFile["src/b.ts"]?.fusionScore, 1 / 61);
    assert.equal(result.fusedResults.find((item) => item.file === "src/c-partial.ts")?.lexicalRank, 3);
    assert.equal(result.fusedResults.find((item) => item.file === "src/c-partial.ts")?.fusionScore, 1 / 63);
    assert.equal(result.fusedResults.find((item) => item.file === "src/d-content.ts")?.lexicalRank, 4);
    assert.equal(result.fusedResults.find((item) => item.file === "src/d-content.ts")?.fusionScore, 1 / 64);

    const repeated = await inspectHybridSearch("load", 10, root, { semanticState: "not_configured" });
    assert.deepEqual(repeated.fusedResults.map((item) => [item.file, item.lexicalRank, item.fusionScore]),
      result.fusedResults.map((item) => [item.file, item.lexicalRank, item.fusionScore]));
  });
});

test("reversing deterministic lexical tie order does not change either candidate's fused score", async () => {
  const scores = async (targetA: string, targetB: string): Promise<Map<string, number>> => withGeneration(
    ambiguityDocuments({ targetA, targetB }),
    async (root) => {
      const result = await inspectHybridSearch("load", 10, root, { semanticState: "not_configured" });
      return new Map(result.fusedResults.filter((item) => item.symbolName === "load").map((item) => [item.content!, item.fusionScore]));
    },
  );
  const forward = await scores("src/a.ts", "src/b.ts");
  const reversed = await scores("src/b.ts", "src/a.ts");

  assert.equal(forward.get("target-A"), forward.get("target-B"));
  assert.equal(reversed.get("target-A"), reversed.get("target-B"));
  assert.equal(forward.get("target-A"), reversed.get("target-A"));
  assert.equal(forward.get("target-B"), reversed.get("target-B"));
});

test("a legitimate semantic result may break an explicit lexical ambiguity tie", async () => {
  await withGeneration(ambiguityDocuments({ targetA: "src/a.ts", targetB: "src/b.ts" }), async (root, repoId) => {
    const embeddingProvider: EmbeddingProvider = {
      id: "frozen-test",
      version: "1",
      dimensions: 2,
      isAvailable: async () => true,
      embedBatch: async () => [[1, 0]],
    };
    const vectorStore = {
      id: "frozen-test-vectors",
      isAvailable: async () => true,
      ensureCollection: async () => undefined,
      search: async () => [{ score: 0.9, payload: { repoId, file: "src/b.ts", symbolName: "load", symbolType: "function", content: "target-B" } }],
      count: async () => 1,
      getIndexedFileStates: async () => new Map(),
      upsert: async () => undefined,
      deletePointIds: async () => undefined,
      deleteFile: async () => undefined,
    } satisfies VectorStore;
    const result = await inspectHybridSearch("load", 10, root, {
      embeddingProvider,
      vectorStore,
      semanticState: "ready",
    });
    const a = result.fusedResults.find((item) => item.file === "src/a.ts")!;
    const b = result.fusedResults.find((item) => item.file === "src/b.ts")!;

    assert.ok(b.fusionScore > a.fusionScore);
    assert.equal(a.lexicalRank, b.lexicalRank);
    assert.equal(b.vectorRank, 1);
  });
});

test("legacy FTS equal scores keep positional RRF ranks without an ambiguity tie group", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-b1-legacy-"));
  await mkdir(path.join(root, ".codeatlas"), { recursive: true });
  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
  const repoId = store.ensureRepository(getRepositoryIdentity(root)).id;
  store.replaceLexicalDocuments(repoId, [
    { file: "src/a.ts", fileHash: "a", documents: [{ documentId: "a", file: "src/a.ts", symbolName: "load", content: "load" }] },
    { file: "src/b.ts", fileHash: "b", documents: [{ documentId: "b", file: "src/b.ts", symbolName: "load", content: "load" }] },
  ], [], "legacy-test");
  store.close();
  try {
    const result = await inspectHybridSearch("load", 10, root, { semanticState: "not_configured" });

    assert.ok(result.lexicalResults.length >= 2);
    assert.ok(result.lexicalResults.every((item) => item.lexicalRankGroup === undefined));
    assert.equal(result.lexicalResults[0]?.lexicalScore, result.lexicalResults[1]?.lexicalScore);
    assert.deepEqual(result.fusedResults.slice(0, 2).map((item) => item.lexicalRank), [1, 2]);
    assert.deepEqual(result.fusedResults.slice(0, 2).map((item) => item.fusionScore), [1 / 61, 1 / 62]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
