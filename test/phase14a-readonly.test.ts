import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { lstat, mkdtemp, realpath, rm, stat, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { loadIndexedGraphReadOnly } from "../src/core/graph/indexed-graph.service.js";
import { indexRepository, migrateLegacyIndexOnMutation } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { createFileHash } from "../src/core/repository/file-hash.js";
import { getRepositoryStatus, getRepositoryStatusReadOnly } from "../src/core/repository/repository-status.service.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { SqliteVectorStore } from "../src/storage/atlas/sqlite-vector.store.js";

const execFile = promisify(execFileCallback);

function openImmutable(databasePath: string): DatabaseSync {
  return new DatabaseSync(`file:${path.resolve(databasePath)}?immutable=1`, { readOnly: true });
}

async function git(repoPath: string, args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd: repoPath, encoding: "utf8" });
  return String(result.stdout);
}

async function legacyFixture(): Promise<string> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-14a-readonly-"));
  await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");
  await git(repoPath, ["init", "-q"]);
  await git(repoPath, ["config", "user.email", "test@example.com"]);
  await git(repoPath, ["config", "user.name", "CodeAtlas Test"]);
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "-qm", "legacy fixture"]);

  const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
  const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
  store.replaceGraph(
    repository.id,
    {
      nodes: [
        { id: "legacy-source", type: "function", name: "legacySource", file: "source.ts", startLine: 1, endLine: 1 },
        { id: "legacy-target", type: "function", name: "legacyTarget", file: "source.ts", startLine: 1, endLine: 1 },
      ],
      edges: [{ from: "legacy-source", to: "legacy-target", type: "calls" }],
    },
    new Map([["source.ts", createFileHash("export function source() { return true; }\n")]]),
    "legacy",
  );
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
    const beforeGitStatus = await git(repoPath, ["status", "--porcelain=v1"]);
    const beforeGitConfig = await git(repoPath, ["config", "--local", "--list"]);
    const beforeDatabase = openImmutable(databasePath);
    const beforeUpdatedAt = (beforeDatabase.prepare("SELECT updated_at FROM repositories LIMIT 1").get() as { updated_at: string }).updated_at;
    const beforeActiveState = beforeDatabase.prepare("SELECT name FROM sqlite_master WHERE name = 'repository_index_state'").get();
    beforeDatabase.close();
    const status = await getRepositoryStatusReadOnly(repoPath);
    const graph = await loadIndexedGraphReadOnly(repoPath);
    const after = await sidecarSnapshot(databasePath);

    assert.equal(status.repository.path, await realpath(repoPath));
    assert.equal(status.graph.status, "stale");
    assert.deepEqual(graph.graph.nodes.map((node) => node.name), ["legacySource", "legacyTarget"]);
    assert.deepEqual(graph.graph.edges, [{ from: "legacy-source", to: "legacy-target", type: "calls" }]);
    assert.deepEqual(after, before);
    assert.equal(await git(repoPath, ["status", "--porcelain=v1"]), beforeGitStatus);
    assert.equal(await git(repoPath, ["config", "--local", "--list"]), beforeGitConfig);
    const database = openImmutable(databasePath);
    assert.equal((database.prepare("SELECT updated_at FROM repositories LIMIT 1").get() as { updated_at: string }).updated_at, beforeUpdatedAt);
    assert.deepEqual(database.prepare("SELECT name FROM sqlite_master WHERE name = 'repository_index_state'").get(), beforeActiveState);
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

test("read-only status sees a freshly written WAL-backed repository", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-14a-wal-status-"));
  const databasePath = path.join(repoPath, ".codeatlas", "atlas.db");
  const vectorStore = new SqliteVectorStore(databasePath);
  try {
    const store = new AtlasStore(databasePath);
    const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
    store.close();

    const status = await getRepositoryStatusReadOnly(repoPath);
    assert.equal(status.repository.repoId, repository.id);
  } finally {
    vectorStore.close();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("status ignores unsupported documentation files for indexed freshness", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-14a-doc-status-"));
  try {
    await writeFile(path.join(repoPath, "source.ts"), "export const source = true;\n");
    const outcome = await indexRepository(repoPath, { skipGit: true });
    assert.equal(outcome.kind, "published");

    await writeFile(path.join(repoPath, "AGENTS.md"), "# Guidance\n");
    const status = await getRepositoryStatusReadOnly(repoPath);
    assert.equal(status.graph.status, "ready");
    assert.equal(status.capabilities.lexical.state, "ready");
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
    const database = openImmutable(path.join(repoPath, ".codeatlas", "atlas.db"));
    const active = database.prepare("SELECT active_generation_id FROM repository_index_state WHERE repository_id = ?").get(outcome.repositoryId) as { active_generation_id: string };
    assert.equal(active.active_generation_id, outcome.generationId);
    assert.equal((database.prepare("SELECT COUNT(*) AS count FROM file_fact_bindings WHERE generation_id = ?").get(outcome.generationId) as { count: number }).count, 1);
    database.close();
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
