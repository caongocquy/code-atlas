import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createDefaultProviders } from "../src/infrastructure/provider-defaults.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { createFileHash } from "../src/core/repository/file-hash.js";
import { syncSemantic } from "../src/core/semantic/semantic-index.service.js";
import { getRepositoryStatus } from "../src/core/repository/repository-status.service.js";
import type { VectorPoint } from "../src/core/semantic/vector-store.js";
import { SqliteVectorStore } from "../src/storage/atlas/sqlite-vector.store.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { GRAPH_INDEX_VERSION, VECTOR_INDEX_VERSION } from "../src/config/constants.js";

async function temporaryDirectory(name: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `code-atlas-phase-6-${name}-`));
}

function point(
  repoId: string,
  id: string,
  file: string,
  fileHash: string,
  vector: number[],
): VectorPoint {
  return {
    id,
    vector,
    payload: { repoId, file, fileHash, content: id },
  };
}

test("SQLite vector storage is persistent, isolated, deterministic, and mutable", async () => {
  const root = await temporaryDirectory("vectors");
  const databasePath = path.join(root, "atlas.db");
  const repoAPath = path.join(root, "a", "same-name");
  const repoBPath = path.join(root, "b", "same-name");
  await mkdir(repoAPath, { recursive: true });
  await mkdir(repoBPath, { recursive: true });

  try {
    const atlas = new AtlasStore(databasePath);
    const repoA = atlas.ensureRepository(getRepositoryIdentity(repoAPath));
    const repoB = atlas.ensureRepository(getRepositoryIdentity(repoBPath));
    atlas.close();

    const vectors = new SqliteVectorStore(databasePath);
    await vectors.ensureCollection(2);
    await vectors.upsert([
      point(repoA.id, "z", "src/a.ts", "a-1", [1, 0]),
      point(repoA.id, "a", "src/a.ts", "a-1", [1, 0]),
      point(repoB.id, "b", "src/b.ts", "b-1", [1, 0]),
    ]);

    assert.equal(await vectors.count(repoA.id), 2);
    assert.deepEqual(
      (await vectors.search(repoA.id, [1, 0], 10)).map((result) => result.payload?.content),
      ["a", "z"],
    );
    assert.equal((await vectors.search(repoB.id, [1, 0], 10)).length, 1);
    assert.deepEqual(
      await vectors.getIndexedFileStates(repoA.id),
      new Map([["src/a.ts", { fileHash: "a-1", pointIds: ["a", "z"] }]]),
    );

    await vectors.upsert([point(repoA.id, "a", "src/a.ts", "a-2", [0, 1])]);
    assert.equal((await vectors.search(repoA.id, [0, 1], 10))[0]?.payload?.fileHash, "a-2");
    await vectors.deleteFile(repoA.id, "src/a.ts");
    assert.equal(await vectors.count(repoA.id), 0);
    vectors.close();

    const reopened = new SqliteVectorStore(databasePath);
    await reopened.ensureCollection(2);
    assert.equal(await reopened.count(repoB.id), 1);
    assert.equal((await reopened.search(repoB.id, [1, 0], 10))[0]?.payload?.content, "b");
    reopened.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the default semantic backend is the built-in local SQLite store", async () => {
  const root = await temporaryDirectory("default");

  try {
    const providers = createDefaultProviders(root);
    assert.equal(providers.vectorStore.id, "sqlite");
    assert.equal(await providers.vectorStore.isAvailable(), true);
    (providers.vectorStore as SqliteVectorStore).close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SQLite vector configuration rejects dimension changes without touching graph metadata", async () => {
  const root = await temporaryDirectory("dimensions");
  const databasePath = path.join(root, "atlas.db");

  try {
    const atlas = new AtlasStore(databasePath);
    const repository = atlas.ensureRepository(getRepositoryIdentity(root));
    atlas.setVersion(repository.id, "graph", GRAPH_INDEX_VERSION);
    atlas.setVersion(repository.id, "semantic", VECTOR_INDEX_VERSION);
    atlas.close();

    const vectors = new SqliteVectorStore(databasePath);
    await vectors.ensureCollection(2);
    await assert.rejects(() => vectors.ensureCollection(3), /dimensions changed/i);
    vectors.close();

    const reopened = new AtlasStore(databasePath);
    try {
      assert.equal(reopened.getVersion(repository.id, "graph"), GRAPH_INDEX_VERSION);
      assert.equal(reopened.getVersion(repository.id, "semantic"), VECTOR_INDEX_VERSION);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("zero-item semantic files remain explicitly ready", async () => {
  const root = await temporaryDirectory("empty");
  const databasePath = path.join(root, ".codeatlas", "atlas.db");
  await writeFile(path.join(root, "empty.ts"), "// no symbols\n");

  try {
    const vectors = new SqliteVectorStore(databasePath);
    await vectors.ensureCollection(2);
    const result = await syncSemantic(root, {
      embeddingProvider: {
        id: "test",
        version: "1",
        dimensions: 2,
        isAvailable: async () => true,
        embedBatch: async () => [],
      },
      vectorStore: vectors,
    });
    assert.equal(result.status, "nothing-to-index");
    vectors.close();

    const atlas = new AtlasStore(databasePath);
    try {
      const repo = atlas.ensureRepository(getRepositoryIdentity(root));
      assert.equal(atlas.getFileCapabilityState(repo.id, "empty.ts", "semantic")?.state, "ready");
      assert.equal(atlas.getFileCapabilityState(repo.id, "empty.ts", "semantic")?.itemCount, 0);
    } finally {
      atlas.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic replacement keeps the previous SQLite generation until activation", async () => {
  const root = await temporaryDirectory("copy-on-write");
  const databasePath = path.join(root, ".codeatlas", "atlas.db");
  const filePath = path.join(root, "source.ts");
  await writeFile(filePath, "export function oldSymbol() { return true; }\n");
  const vectors = new SqliteVectorStore(databasePath);

  const provider = (version: string, fail = false) => ({
    id: "test",
    version,
    dimensions: 2,
    isAvailable: async () => true,
    embedBatch: async (texts: string[]) => {
      if (fail) throw new Error("embedding failed");
      return texts.map(() => version === "1" ? [1, 0] : [0, 1]);
    },
  });

  try {
    const first = await syncSemantic(root, {
      embeddingProvider: provider("1"),
      vectorStore: vectors,
    });
    assert.equal(first.status, "indexed");
    const oldCount = await vectors.count(first.repoId);
    assert.ok(oldCount > 0);

    await writeFile(filePath, "export function newSymbol() { return false; }\n");
    await assert.rejects(
      syncSemantic(root, {
        embeddingProvider: provider("2", true),
        vectorStore: vectors,
      }),
      /embedding failed/,
    );
    assert.equal(await vectors.count(first.repoId), oldCount);

    const replaced = await syncSemantic(root, {
      embeddingProvider: provider("2"),
      vectorStore: vectors,
    });
    assert.equal(replaced.status, "indexed");
    assert.equal(await vectors.count(replaced.repoId), oldCount);
    assert.equal(
      (await vectors.search(replaced.repoId, [0, 1], 10))[0]?.payload?.content
        ?.toString().includes("newSymbol"),
      true,
    );
    assert.equal(
      (await vectors.search(replaced.repoId, [1, 0], 10)).some((result) =>
        result.payload?.content?.toString().includes("oldSymbol"),
      ),
      false,
    );
  } finally {
    vectors.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy external vector metadata is stale and cannot authorize SQLite reuse", async () => {
  const root = await temporaryDirectory("backend-switch");
  const databasePath = path.join(root, ".codeatlas", "atlas.db");
  const content = "export function backendSwitch() { return true; }\n";
  await writeFile(path.join(root, "source.ts"), content);
  const vectors = new SqliteVectorStore(databasePath);
  const embeddingProvider = {
    id: "test",
    version: "1",
    dimensions: 2,
    isAvailable: async () => true,
    embedBatch: async () => [[1, 0]],
  };

  try {
    const atlas = new AtlasStore(databasePath);
    const repository = atlas.ensureRepository(getRepositoryIdentity(root));
    atlas.setVersion(repository.id, "semantic", VECTOR_INDEX_VERSION);
    atlas.setFileCapabilityState(repository.id, "source.ts", "semantic", {
      fileHash: createFileHash(content),
      version: VECTOR_INDEX_VERSION,
      state: "ready",
      providerIdentity: "test@1@2",
      generation: `v${VECTOR_INDEX_VERSION}:${createFileHash(content)}`,
      itemCount: 1,
    });
    atlas.close();

    const status = await getRepositoryStatus(root, {
      embeddingProvider,
      vectorStore: vectors,
    });
    assert.equal(status.capabilities.semantic.state, "stale");

    const result = await syncSemantic(root, {
      embeddingProvider,
      vectorStore: vectors,
    });
    assert.equal(result.status, "indexed");
    assert.equal(await vectors.count(result.repoId), 1);
  } finally {
    vectors.close();
    await rm(root, { recursive: true, force: true });
  }
});
