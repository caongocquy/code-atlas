import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { lstat, mkdir, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";

import { loadIndexedGraphReadOnly } from "../src/core/graph/indexed-graph.service.js";
import { migrateLegacyIndexOnMutation } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { getRepositoryStatus, getRepositoryStatusReadOnly } from "../src/core/repository/repository-status.service.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

async function legacyFixture(): Promise<string> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-14a-readonly-"));
  await mkdir(path.join(repoPath, ".git"));
  await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");

  const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
  store.ensureRepository(getRepositoryIdentity(repoPath));
  store.close();
  const database = new DatabaseSync(path.join(repoPath, ".codeatlas", "atlas.db"));
  database.exec(`
    DROP TABLE generation_edges;
    DROP TABLE generation_symbols;
    DROP TABLE generation_lexical_documents;
    DROP TABLE generation_semantic_vectors;
    DROP TABLE file_fact_bindings;
    DROP TABLE index_manifests;
    DROP TABLE index_generations;
    DROP TABLE repository_index_state;
    DROP TABLE fact_blobs;
  `);
  database.close();
  return repoPath;
}

async function sidecarSnapshot(databasePath: string) {
  const snapshot = async (suffix: string) => {
    try {
      const entry = await lstat(`${databasePath}${suffix}`);
      return [entry.mtimeMs, entry.size] as const;
    } catch {
      return undefined;
    }
  };
  return { database: (await stat(databasePath)).mtimeMs, wal: await snapshot("-wal"), shm: await snapshot("-shm") };
}

test("legacy read-only status and graph loading do not create v2 state or mutate storage", async () => {
  const repoPath = await legacyFixture();
  try {
    const databasePath = path.join(repoPath, ".codeatlas", "atlas.db");
    const before = await sidecarSnapshot(databasePath);
    const status = await getRepositoryStatusReadOnly(repoPath);
    const graph = await loadIndexedGraphReadOnly(repoPath).catch(() => undefined);
    const after = await sidecarSnapshot(databasePath);

    assert.equal(status.repository.path, await realpath(repoPath));
    assert.equal(status.graph.status, "not_indexed");
    assert.equal(graph, undefined);
    assert.deepEqual(after, before);
    const database = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'repository_index_state'").get(), undefined);
    database.close();
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("the shared repository status service is read-only by default", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-14a-status-"));
  try {
    await writeFile(path.join(repoPath, "source.ts"), "export const source = true;\n");
    await getRepositoryStatus(repoPath);
    await assert.rejects(() => stat(path.join(repoPath, ".codeatlas", "atlas.db")));
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("legacy mutation performs source indexing and publishes a v2 generation", async () => {
  const repoPath = await legacyFixture();
  try {
    const outcome = await migrateLegacyIndexOnMutation(repoPath, { skipGit: true });
    assert.equal(outcome.kind, "published");
    if (outcome.kind !== "published") return;
    const database = new DatabaseSync(path.join(repoPath, ".codeatlas", "atlas.db"), { readOnly: true });
    const active = database.prepare("SELECT active_generation_id FROM repository_index_state WHERE repository_id = ?").get(outcome.repositoryId) as { active_generation_id: string };
    assert.equal(active.active_generation_id, outcome.generationId);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM file_fact_bindings WHERE generation_id = ?").get(outcome.generationId) as { count: number }).count, 1);
    database.close();
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
