import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { loadIndexedGraphReadOnly, loadIndexedMessageGraphReadOnly } from "../src/core/graph/indexed-graph.service.js";
import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

async function indexedRepo() {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase17c-e1-loader-"));
  const sourcePath = path.join(repoPath, "source.ts");
  await writeFile(sourcePath, "export function source() { return 'generation-one'; }\n");
  const result = await indexRepository(repoPath, { skipGit: true });
  assert.equal(result.kind, "published", result.kind === "failed" ? result.failure.message : undefined);
  return { repoPath, sourcePath };
}

async function atlasStorageHash(repoPath: string) {
  const databasePath = path.join(repoPath, ".codeatlas", "atlas.db");
  const hashes: string[] = [];
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      const bytes = await readFile(`${databasePath}${suffix}`);
      hashes.push(`${suffix}:${createHash("sha256").update(bytes).digest("hex")}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      hashes.push(`${suffix}:missing`);
    }
  }
  return hashes;
}

test("message graph read pins graph, framework manifest, and validated facts to one generation", async () => {
  const { repoPath } = await indexedRepo();
  try {
    const loaded = await loadIndexedMessageGraphReadOnly(repoPath);
    assert.ok(loaded.evidenceState.generationId);
    assert.equal(loaded.generationManifest?.generationId, loaded.evidenceState.generationId);
    assert.ok(loaded.graph.nodes.some((node) => node.file === "source.ts"));
    assert.ok(loaded.sourceFacts.some(({ relativePath, facts }) =>
      relativePath === "source.ts" && facts.contentHash.length > 0));
    assert.ok(loaded.generationManifest?.files.every((file) =>
      file.generationId === loaded.evidenceState.generationId && file.repositoryId === loaded.repoId));
    assert.deepEqual(loaded.factDiagnostics, []);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("message graph read reports an unindexed repository without creating its Atlas database", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase17c-e1-unindexed-"));
  try {
    await assert.rejects(loadIndexedMessageGraphReadOnly(repoPath), { message: "Repository graph is not indexed." });
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("missing and corrupt generation fact blobs are diagnosed and omitted", async () => {
  const { repoPath } = await indexedRepo();
  const databasePath = path.join(repoPath, ".codeatlas", "atlas.db");
  try {
    const initial = await loadIndexedMessageGraphReadOnly(repoPath);
    const generationId = initial.evidenceState.generationId!;
    const database = new DatabaseSync(databasePath);
    try {
      database.exec("PRAGMA foreign_keys = OFF;");
      const binding = initial.generationManifest!.files.find((file) => file.relativePath === "source.ts")!;
      database.prepare("DELETE FROM fact_blobs WHERE fact_blob_key = ?").run(binding.factBlobKey);
    } finally {
      database.close();
    }
    const missing = await loadIndexedMessageGraphReadOnly(repoPath);
    assert.equal(missing.evidenceState.generationId, generationId);
    assert.equal(missing.sourceFacts.some((file) => file.relativePath === "source.ts"), false);
    assert.ok(missing.factDiagnostics.some((item) => item.file === "source.ts"));
    assert.deepEqual(missing.evidenceState, (await loadIndexedGraphReadOnly(repoPath)).evidenceState);

    const fresh = await indexedRepo();
    try {
      const before = await loadIndexedMessageGraphReadOnly(fresh.repoPath);
      const corruptDb = new DatabaseSync(path.join(fresh.repoPath, ".codeatlas", "atlas.db"));
      try {
        const binding = before.generationManifest!.files.find((file) => file.relativePath === "source.ts")!;
        corruptDb.prepare("UPDATE fact_blobs SET payload_json = '{' WHERE fact_blob_key = ?").run(binding.factBlobKey);
      } finally {
        corruptDb.close();
      }
      const corrupt = await loadIndexedMessageGraphReadOnly(fresh.repoPath);
      assert.equal(corrupt.sourceFacts.some((file) => file.relativePath === "source.ts"), false);
      assert.ok(corrupt.factDiagnostics.some((item) => item.file === "source.ts"));
    } finally {
      await rm(fresh.repoPath, { recursive: true, force: true });
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("invalid fact paths, binding hashes, and manifest versions fail closed", async () => {
  for (const mutate of [
    (database: DatabaseSync) => database.prepare("UPDATE file_fact_bindings SET relative_path = '../source.ts'").run(),
    (database: DatabaseSync) => database.prepare("UPDATE file_fact_bindings SET content_hash = 'wrong-hash'").run(),
    (database: DatabaseSync) => {
      const row = database.prepare("SELECT generation_id, versions_json FROM index_manifests").get() as { generation_id: string; versions_json: string };
      database.prepare("UPDATE index_manifests SET versions_json = ? WHERE generation_id = ?")
        .run(JSON.stringify({ ...JSON.parse(row.versions_json), factsVersion: "wrong-version" }), row.generation_id);
    },
  ]) {
    const { repoPath } = await indexedRepo();
    try {
      const database = new DatabaseSync(path.join(repoPath, ".codeatlas", "atlas.db"));
      try { mutate(database); } finally { database.close(); }
      const loaded = await loadIndexedMessageGraphReadOnly(repoPath);
      assert.equal(loaded.sourceFacts.some((file) => file.relativePath === "source.ts"), false);
      assert.ok(loaded.factDiagnostics.length > 0);
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  }
});

test("message graph reads use indexed facts only and repeat without mutation", async () => {
  const { repoPath, sourcePath } = await indexedRepo();
  try {
    const first = await loadIndexedMessageGraphReadOnly(repoPath);
    const originalHash = first.sourceFacts.find((file) => file.relativePath === "source.ts")?.facts.contentHash;
    await writeFile(sourcePath, "export function source() { return 'filesystem-only-change'; }\n");
    const databaseBefore = await atlasStorageHash(repoPath);
    const staleRead = await loadIndexedMessageGraphReadOnly(repoPath);
    const repeated = await loadIndexedMessageGraphReadOnly(repoPath);
    const databaseAfter = await atlasStorageHash(repoPath);
    assert.equal(staleRead.sourceFacts.find((file) => file.relativePath === "source.ts")?.facts.contentHash, originalHash);
    assert.deepEqual(repeated, staleRead);
    assert.equal(staleRead.evidenceState.generationId, first.evidenceState.generationId);
    assert.deepEqual(databaseAfter, databaseBefore);
    assert.deepEqual(staleRead.evidenceState, (await loadIndexedGraphReadOnly(repoPath)).evidenceState);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("Atlas message inputs read the active generation once and remain pinned across a concurrent switch", async () => {
  const { repoPath, sourcePath } = await indexedRepo();
  const dbPath = path.join(repoPath, ".codeatlas", "atlas.db");
  const writer = new DatabaseSync(dbPath);
  const originalGetActive = AtlasStore.prototype.getActiveGenerationId;
  let switched = false;
  let activeReads = 0;
  try {
    writer.exec("PRAGMA journal_mode = WAL;");
    const storeForIdentity = new AtlasStore(dbPath, { readOnly: true });
    const repository = storeForIdentity.findRepository(getRepositoryIdentity(repoPath));
    const generationOne = storeForIdentity.getActiveGenerationId(repository!.id)!;
    storeForIdentity.close();

    await writeFile(sourcePath, "export function source() { return 'generation-two'; }\n");
    const indexed = await indexRepository(repoPath, { skipGit: true });
    assert.equal(indexed.kind, "published");
    const generationTwo = indexed.generationId;
    assert.notEqual(generationTwo, generationOne);

    writer.prepare("UPDATE repository_index_state SET active_generation_id = ? WHERE repository_id = ?")
      .run(generationOne, repository!.id);
    const store = new AtlasStore(dbPath, { readOnly: true });
    const before = store.loadMessageGraphQueryInputs(repository!.id);
    AtlasStore.prototype.getActiveGenerationId = function (repositoryId: string) {
      activeReads += 1;
      const generationId = originalGetActive.call(this, repositoryId);
      if (!switched) {
        switched = true;
        writer.prepare("UPDATE repository_index_state SET active_generation_id = ? WHERE repository_id = ?")
          .run(generationTwo, repository!.id);
      }
      return generationId;
    };
    try {
      const loaded = store.loadMessageGraphQueryInputs(repository!.id);
      assert.equal(activeReads, 1);
      assert.equal(loaded.generationId, generationOne);
      assert.equal(loaded.generationManifest?.generationId, generationOne);
      assert.deepEqual(loaded.graph, before.graph);
      assert.deepEqual(loaded.framework, before.framework);
      assert.deepEqual(loaded.sourceFacts, before.sourceFacts);
      assert.equal(store.getActiveGenerationId(repository!.id), generationTwo);
    } finally {
      store.close();
      AtlasStore.prototype.getActiveGenerationId = originalGetActive;
    }
  } finally {
    AtlasStore.prototype.getActiveGenerationId = originalGetActive;
    writer.close();
    await rm(repoPath, { recursive: true, force: true });
  }
});
