import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildEffectiveLexicalRanks, normalizeFusionTies } from "../eval/retrieval/run.js";
import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { searchableIdentifier } from "../src/core/lexical/searchable-identifier.js";
import type { SearchResult } from "../src/core/retrieval/code-search.service.js";
import { inspectHybridSearch } from "../src/core/retrieval/hybrid-search.service.js";
import { retrievalCandidateKey } from "../src/core/retrieval/retrieval-candidate-key.js";
import { inspectRetrieval } from "../src/core/retrieval/retrieval-inspector.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import type { EmbeddingProvider } from "../src/core/semantic/embedding-provider.js";
import type { VectorStore } from "../src/core/semantic/vector-store.js";

test("CA-01 candidate identity matches exact encoded names without collapsing source ranges or repositories", () => {
  const raw = { score: 1, repoId: "repo", file: "a.ts", symbolType: "method", symbolName: "loadCache", startLine: 3, endLine: 5 };
  const lexical = { ...raw, symbolName: searchableIdentifier(raw.symbolName) };
  assert.equal(retrievalCandidateKey(raw), retrievalCandidateKey(lexical, "lexical"));
  for (const patch of [{ repoId: "other" }, { file: "b.ts" }, { symbolType: "function" }, { startLine: 4 }, { endLine: 6 }, { symbolName: "loadCache unrelated" }]) {
    assert.notEqual(retrievalCandidateKey(raw), retrievalCandidateKey({ ...lexical, ...patch }, "lexical"));
  }
  assert.notEqual(retrievalCandidateKey(raw), retrievalCandidateKey({ ...lexical, endLine: undefined }, "lexical"));
  const graph: SearchResult = { ...raw, repoId: undefined };
  assert.equal(retrievalCandidateKey(graph, "raw", raw.repoId), retrievalCandidateKey(raw));
  const multiword = { ...raw, symbolName: "operator new" };
  assert.equal(retrievalCandidateKey(multiword), retrievalCandidateKey({ ...multiword, symbolName: searchableIdentifier(multiword.symbolName) }, "lexical"));
});

test("CA-01 evaluator reconstructs combined RRF contributions using the same candidate identity", () => {
  const raw = { score: 1, repoId: "repo", file: "a.ts", symbolType: "function", symbolName: "loadCache", startLine: 1, endLine: 1 };
  const lexical = { ...raw, symbolName: searchableIdentifier(raw.symbolName), documentId: "doc", lexicalScore: 1, snippet: "loadCache" };
  const combined = { ...raw, vectorRank: 1, lexicalRank: 1, fusionScore: 0 };
  const rebuilt = normalizeFusionTies([combined], new Map([[retrievalCandidateKey(raw), 2]]), buildEffectiveLexicalRanks([lexical]), [lexical]);
  assert.equal(rebuilt[0]?.fusionScore, 1 / 62 + 1 / 61);
  assert.equal(rebuilt[0]?.vectorRank, 2);
  assert.equal(rebuilt[0]?.lexicalRank, 1);
});

test("CA-01 hybrid fusion combines vector and lexical evidence for one indexed occurrence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-ca01-candidate-"));
  try {
    const source = "export function loadCache() { return 7; }";
    await writeFile(path.join(root, "main.ts"), source + "\n");
    const indexed = await indexRepository(root, { skipGit: true });
    assert.equal(indexed.kind, "published", JSON.stringify(indexed));
    const repoId = getRepositoryIdentity(root).id;
    const embeddingProvider: EmbeddingProvider = {
      id: "ca01-test", version: "1", dimensions: 2,
      isAvailable: async () => true, embedBatch: async () => [[1, 0]],
    };
    const vectorStore = {
      id: "ca01-test-vectors", isAvailable: async () => true,
      ensureCollection: async () => undefined,
      search: async () => [{ score: 0.9, payload: { repoId, file: "main.ts", symbolName: "loadCache", symbolType: "function", startLine: 1, endLine: 1, content: source } }],
      count: async () => 1, getIndexedFileStates: async () => new Map(),
      upsert: async () => undefined, deletePointIds: async () => undefined, deleteFile: async () => undefined,
    } satisfies VectorStore;
    const providers = { embeddingProvider, vectorStore, semanticState: "ready" as const };
    const result = await inspectHybridSearch("loadCache", 10, root, providers);
    assert.equal(result.vectorResults[0]?.symbolName, "loadCache");
    assert.equal(result.lexicalResults[0]?.symbolName, searchableIdentifier("loadCache"));
    assert.equal(result.fusedResults.length, 1);
    assert.equal(result.fusedResults[0]?.fusionScore, 2 / 61);
    assert.equal(result.fusedResults[0]?.vectorRank, 1);
    assert.equal(result.fusedResults[0]?.lexicalRank, 1);
    const inspection = await inspectRetrieval("loadCache", { repoPath: root, providers });
    assert.equal(inspection.fusedResults[0]?.source, "both");
    assert.equal(inspection.withGraph.chunks.filter((chunk) => chunk.symbolType === "function" && chunk.startLine === 1 && chunk.file === "main.ts").length, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
