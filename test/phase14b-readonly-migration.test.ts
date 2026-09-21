import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { lstat, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";

import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

type LegacyAtlasFixture = { dbPath: string; repositoryId: string };

async function createLegacyAtlasFixture(): Promise<LegacyAtlasFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14b-readonly-"));
  const dbPath = path.join(root, "atlas.db");
  const database = new DatabaseSync(dbPath);
  database.exec(`
    CREATE TABLE atlas_schema (id INTEGER PRIMARY KEY, version TEXT NOT NULL);
    INSERT INTO atlas_schema VALUES (1, '1');
    CREATE TABLE repositories (id TEXT PRIMARY KEY, identity_key TEXT NOT NULL, root_path TEXT NOT NULL, display_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE symbols (id TEXT NOT NULL, repository_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT, file_path TEXT NOT NULL, start_line INTEGER, end_line INTEGER);
    CREATE TABLE edges (repository_id TEXT NOT NULL, owner_file TEXT NOT NULL, from_symbol_id TEXT NOT NULL, to_symbol_id TEXT NOT NULL, type TEXT NOT NULL, resolution_method TEXT, evidence_kind TEXT, confidence REAL, resolution_file TEXT, resolution_line INTEGER);
    INSERT INTO repositories VALUES ('legacy-repo', 'legacy:legacy-repo', '.', 'legacy', 'created', 'updated');
    INSERT INTO symbols VALUES ('source', 'legacy-repo', 'function', 'source', 'source', 'source.ts', 1, 1);
    INSERT INTO symbols VALUES ('target', 'legacy-repo', 'function', 'target', 'target', 'target.ts', 2, 2);
    INSERT INTO edges VALUES ('legacy-repo', 'source.ts', 'source', 'target', 'calls', 'same_file', 'INFERRED', 0.9, 'source.ts', 1);
  `);
  database.close();
  return { dbPath, repositoryId: "legacy-repo" };
}

async function snapshotDbFiles(dbPath: string): Promise<Readonly<Record<string, string>>> {
  const snapshot: Record<string, string> = {};
  for (const suffix of ["", "-wal", "-shm"]) {
    const filePath = `${dbPath}${suffix}`;
    try {
      const metadata = await stat(filePath);
      const entry = await lstat(filePath);
      snapshot[suffix || "db"] = `${metadata.mtimeMs}:${entry.size}:${(await readFile(filePath)).toString("base64")}`;
    } catch {
      snapshot[suffix || "db"] = "missing";
    }
  }
  return snapshot;
}

test("read-only open does not migrate legacy provenance schema", async () => {
  const fixture = await createLegacyAtlasFixture();
  try {
    const before = await snapshotDbFiles(fixture.dbPath);
    const store = new AtlasStore(fixture.dbPath, { readOnly: true });
    assert.equal(store.loadGraph(fixture.repositoryId).edges[0]?.resolution, undefined);
    store.close();
    assert.deepEqual(await snapshotDbFiles(fixture.dbPath), before);
  } finally {
    await rm(path.dirname(fixture.dbPath), { recursive: true, force: true });
  }
});
