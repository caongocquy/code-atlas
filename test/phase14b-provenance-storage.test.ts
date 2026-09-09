import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { symbolIdentityKey } from "../src/core/graph/resolver/identities.js";
import { MAX_COMPACT_EVIDENCE } from "../src/core/graph/resolver/provenance.js";
import type { EdgeResolutionProvenance } from "../src/core/graph/resolution.types.js";
import type { GraphEdge } from "../src/core/graph/types.js";
import { createCandidateGeneration } from "../src/core/indexing/index-manifest.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

let databasePath = "";
let repositoryId = "";

const versions = {
  schemaVersion: "2",
  factsSchemaVersion: "facts-schema-7",
  factsVersion: "facts-7",
  resolutionVersion: "resolution-7",
  derivedVersion: "derived-7",
};

function openWritableFixtureStore(): AtlasStore {
  return new AtlasStore(databasePath);
}

function edgeWithProvenance(overrides: Partial<EdgeResolutionProvenance> = {}): GraphEdge {
  const id = repositoryId || getRepositoryIdentity(path.join(path.dirname(databasePath), "repo")).id;
  const source = symbolIdentityKey({ repositoryId: id, relativePath: "source.ts", language: "typescript", kind: "function", qualifiedName: "source", discriminator: "1" });
  const target = symbolIdentityKey({ repositoryId: id, relativePath: "target.ts", language: "typescript", kind: "function", qualifiedName: "target", discriminator: "1" });
  return {
    from: "source",
    to: "target",
    type: "calls",
    resolution: {
      strategy: "constructor",
      confidence: "exact",
      evidence: [{ kind: "call-site", sourceUnit: "source.ts", startLine: 3, endLine: 3 }],
      resolutionVersion: "1.0.0",
      sourceLogicalIdentity: source,
      targetLogicalIdentity: target,
      ...overrides,
    },
  };
}

function writeCandidateWithEdge(store: AtlasStore, edge: GraphEdge): string {
  const repository = store.ensureRepository(getRepositoryIdentity(path.join(path.dirname(databasePath), "repo")));
  repositoryId = repository.id;
  const generation = createCandidateGeneration(repository.id, undefined, versions, []);
  store.beginCandidateGeneration(generation);
  store.writeCandidateManifest(generation.manifest);
  store.writeCandidateGraph(generation.id, {
    nodes: [
      { id: "source", type: "function", name: "source", file: "source.ts" },
      { id: "target", type: "function", name: "target", file: "target.ts" },
    ],
    edges: [edge],
  }, new Map());
  return generation.id;
}

function publishFixtureGeneration(store: AtlasStore, generationId: string): void {
  store.publishCandidateGeneration(generationId);
}

async function withFixture(run: () => void | Promise<void>): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14b-storage-"));
  databasePath = path.join(root, "atlas.db");
  repositoryId = "";
  try {
    await run();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("candidate edge provenance survives close and reopen", async () => withFixture(() => {
  const store = openWritableFixtureStore();
  const generationId = writeCandidateWithEdge(store, edgeWithProvenance());
  publishFixtureGeneration(store, generationId);
  const expectedRepositoryId = repositoryId;
  store.close();

  const reopened = openWritableFixtureStore();
  const edge = reopened.loadGraph(expectedRepositoryId).edges[0];
  assert.equal(edge?.resolution?.confidence, "exact");
  assert.equal(edge?.resolution?.strategy, "constructor");
  assert.equal(edge?.resolution?.resolutionVersion, "1.0.0");
  assert.equal(edge?.resolution?.sourceLogicalIdentity.includes(expectedRepositoryId), true);
  assert.equal(edge?.resolution?.evidence.length, 1);
  reopened.close();
}));

test("writable schema-1 databases migrate once and keep facts schema independent", async () => withFixture(() => {
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE atlas_schema (id INTEGER PRIMARY KEY, version TEXT NOT NULL);");
  database.prepare("INSERT INTO atlas_schema (id, version) VALUES (1, '1')").run();
  database.close();

  const store = openWritableFixtureStore();
  const generationId = writeCandidateWithEdge(store, edgeWithProvenance());
  publishFixtureGeneration(store, generationId);
  store.close();

  const migrated = new DatabaseSync(databasePath, { readOnly: true });
  assert.equal((migrated.prepare("SELECT version FROM atlas_schema").get() as { version: string }).version, "2");
  for (const table of ["edges", "generation_edges"]) {
    const columns = migrated.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    assert.equal(columns.some((column) => column.name === "resolution_evidence_json"), true);
  }
  const state = migrated.prepare("SELECT active_facts_version, active_facts_schema_version FROM repository_index_state WHERE repository_id = ?").get(repositoryId) as { active_facts_version: string; active_facts_schema_version: string };
  assert.equal(state.active_facts_version, "facts-7");
  assert.equal(state.active_facts_schema_version, "facts-schema-7");
  migrated.close();
}));

test("read-only schema-1 construction does not mutate or migrate legacy rows", async () => withFixture(async () => {
  const database = new DatabaseSync(databasePath);
  database.exec(`
    CREATE TABLE atlas_schema (id INTEGER PRIMARY KEY, version TEXT NOT NULL);
    INSERT INTO atlas_schema VALUES (1, '1');
    CREATE TABLE repositories (id TEXT PRIMARY KEY, identity_key TEXT NOT NULL, root_path TEXT NOT NULL, display_name TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL);
    CREATE TABLE symbols (id TEXT NOT NULL, repository_id TEXT NOT NULL, type TEXT NOT NULL, name TEXT NOT NULL, qualified_name TEXT, file_path TEXT NOT NULL, start_line INTEGER, end_line INTEGER);
    CREATE TABLE edges (repository_id TEXT NOT NULL, owner_file TEXT NOT NULL, from_symbol_id TEXT NOT NULL, to_symbol_id TEXT NOT NULL, type TEXT NOT NULL, resolution_method TEXT, evidence_kind TEXT, confidence REAL, resolution_file TEXT, resolution_line INTEGER);
    INSERT INTO repositories VALUES ('legacy-repo', 'legacy:legacy-repo', 'repo', 'repo', 'created', 'updated');
    INSERT INTO symbols VALUES ('source', 'legacy-repo', 'function', 'source', 'source', 'source.ts', 1, 2);
    INSERT INTO symbols VALUES ('target', 'legacy-repo', 'function', 'target', 'target', 'target.ts', 3, 4);
    INSERT INTO edges VALUES ('legacy-repo', 'source.ts', 'source', 'target', 'calls', 'same_file', 'INFERRED', 0.9, 'source.ts', 1);
  `);
  database.close();
  const before = await readFile(databasePath);

  const store = new AtlasStore(databasePath, { readOnly: true });
  assert.equal(store.loadGraph("legacy-repo").edges[0]?.resolution, undefined);
  store.close();
  assert.deepEqual(await readFile(databasePath), before);
  const version = (new DatabaseSync(databasePath, { readOnly: true }).prepare("SELECT version FROM atlas_schema").get() as { version: string }).version;
  assert.equal(version, "1");
}));

test("candidate writes roll back invalid logical identities", async () => withFixture(() => {
  const store = openWritableFixtureStore();
  assert.throws(() => writeCandidateWithEdge(store, edgeWithProvenance({ sourceLogicalIdentity: "not-canonical" })), /canonical symbol identity keys/);
  const check = new DatabaseSync(databasePath, { readOnly: true });
  const count = check.prepare("SELECT count(*) AS count FROM generation_edges").get() as { count: number };
  assert.equal(count.count, 0);
  check.close();
  store.close();
}));

test("persisted evidence is sorted and bounded", async () => withFixture(() => {
  const evidence = Array.from({ length: MAX_COMPACT_EVIDENCE + 3 }, (_, index) => ({ kind: "kind", sourceUnit: `source-${MAX_COMPACT_EVIDENCE - index}.ts`, startLine: index, endLine: index }));
  const store = openWritableFixtureStore();
  const generationId = writeCandidateWithEdge(store, edgeWithProvenance({ evidence }));
  publishFixtureGeneration(store, generationId);
  const loaded = store.loadGraph(repositoryId).edges[0]?.resolution?.evidence ?? [];
  assert.equal(loaded.length, MAX_COMPACT_EVIDENCE);
  assert.deepEqual(loaded, [...loaded].sort((a, b) => a.sourceUnit.localeCompare(b.sourceUnit) || a.startLine - b.startLine || a.endLine - b.endLine || a.kind.localeCompare(b.kind)));
  store.close();
}));

test("read-only construction rejects unknown schema versions without writing", async () => withFixture(async () => {
  const database = new DatabaseSync(databasePath);
  database.exec("CREATE TABLE atlas_schema (id INTEGER PRIMARY KEY, version TEXT NOT NULL);");
  database.prepare("INSERT INTO atlas_schema (id, version) VALUES (1, '999')").run();
  database.close();
  const before = await readFile(databasePath);

  assert.throws(
    () => new AtlasStore(databasePath, { readOnly: true }),
    /Unsupported AtlasStore schema version: 999; expected 2/,
  );
  assert.deepEqual(await readFile(databasePath), before);
}));
