import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";

import { createCandidateGeneration } from "../src/core/indexing/index-manifest.js";
import { searchCode } from "../src/core/retrieval/code-search.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { SqliteVectorStore } from "../src/storage/atlas/sqlite-vector.store.js";

const versions = { schemaVersion: "2", factsSchemaVersion: "1", factsVersion: "1", resolutionVersion: "1", derivedVersion: "1" };

for (const legacy of [false, true]) {
  test(`duplicate vector writes stay invisible before publication (${legacy ? "legacy upgrade" : "first index"})`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "atlas-release-vector-isolation-"));
    const repoPath = path.join(root, "repo");
    const databasePath = path.join(root, "atlas.db");
    const store = new AtlasStore(databasePath);
    const repoId = store.ensureRepository(getRepositoryIdentity(repoPath)).id;
    const vectorStore = new SqliteVectorStore(databasePath, repoId);
    const embeddingProvider = {
      id: "test", version: "1", dimensions: 2,
      isAvailable: async () => true,
      embedBatch: async (texts: string[]) => texts.map(() => [1, 0]),
    };
    const point = (id: string, generationId: string) => ({
      id, vector: [1, 0],
      payload: { repoId, file: `${id}.ts`, fileHash: id, content: id, generationId },
    });
    const assertReaders = async (expected: string[]) => {
      const results = await searchCode("query", 10, { repoPath, embeddingProvider, vectorStore });
      assert.deepEqual(results.map((result) => result.content), expected);
      assert.equal(await vectorStore.count(repoId), expected.length);
      assert.deepEqual([...(await vectorStore.getIndexedFileStates(repoId)).keys()], expected.map((id) => `${id}.ts`));
    };
    const stage = async (id: string, parent?: string) => {
      const generation = createCandidateGeneration(repoId, parent, versions, []);
      store.beginCandidateGeneration(generation);
      store.writeCandidateManifest(generation.manifest);
      const points = [point(id, generation.id)];
      await vectorStore.upsert(points);
      store.writeCandidateSemanticVectors(generation.id, points);
      return generation;
    };
    try {
      await vectorStore.ensureCollection(2);
      if (legacy) await vectorStore.upsert([point("legacy", "legacy-file-generation")]);
      await assertReaders(legacy ? ["legacy"] : []);
      const first = await stage("first");
      await assertReaders(legacy ? ["legacy"] : []);
      assert.deepEqual(store.getActiveSemanticPoints(repoId, ["first.ts"]), []);
      store.publishCandidateGeneration(first.id, { semanticEnabled: true });
      await assertReaders(["first"]);

      const losing = await stage("losing", first.id);
      const winning = await stage("winning", first.id);
      await assertReaders(["first"]);
      store.publishCandidateGeneration(winning.id, { semanticEnabled: true });
      assert.throws(() => store.publishCandidateGeneration(losing.id, { semanticEnabled: true }), /parent generation is no longer active/);
      await assertReaders(["winning"]);
      assert.deepEqual(store.getActiveSemanticPoints(repoId, ["first.ts", "losing.ts", "winning.ts"]).map((value) => value.payload.content), ["winning"]);

      const empty = createCandidateGeneration(repoId, winning.id, versions, []);
      store.beginCandidateGeneration(empty);
      store.writeCandidateManifest(empty.manifest);
      store.publishCandidateGeneration(empty.id);
      await assertReaders([]);

      const database = new DatabaseSync(databasePath, { readOnly: true });
      try {
        assert.equal((database.prepare("SELECT count(*) AS n FROM semantic_vectors WHERE repository_id = ?").get(repoId) as { n: number }).n, legacy ? 4 : 3);
      } finally { database.close(); }
    } finally {
      vectorStore.close();
      store.close();
      await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
    }
  });
}

test("legacy read-only vector readers work without generation tables", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "atlas-release-legacy-vector-"));
  const databasePath = path.join(root, "atlas.db");
  const repoId = getRepositoryIdentity(path.join(root, "repo")).id;
  const writer = new AtlasStore(databasePath);
  writer.ensureRepository(getRepositoryIdentity(path.join(root, "repo")));
  writer.ensureSemanticVectorDimensions(2);
  writer.upsertSemanticVectors([{ id: "legacy", vector: [1, 0], payload: { repoId, file: "legacy.ts", fileHash: "legacy", content: "legacy" } }]);
  writer.close();
  const database = new DatabaseSync(databasePath);
  database.exec("DROP TABLE index_generations; DROP TABLE repository_index_state;");
  database.close();
  const reader = new SqliteVectorStore(databasePath, repoId, { readOnly: true });
  try {
    assert.deepEqual((await reader.search(repoId, [1, 0], 10)).map((point) => point.payload?.content), ["legacy"]);
    assert.equal(await reader.count(repoId), 1);
    assert.deepEqual([...(await reader.getIndexedFileStates(repoId)).keys()], ["legacy.ts"]);
  } finally {
    reader.close();
    await rm(root, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  }
});
