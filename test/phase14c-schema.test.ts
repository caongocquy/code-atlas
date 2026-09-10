import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { lstat, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";

import {
  ATLAS_SCHEMA_VERSION,
  initializeAtlasSchema,
  migrateAtlasSchema,
  validateAtlasSchemaForReadOnly,
} from "../src/storage/atlas/atlas.schema.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { INDEX_SCHEMA_VERSION } from "../src/core/repository/index-version.js";

type SchemaVersion = "1" | "2";

const FRAMEWORK_TABLES = [
  "generation_framework_entities",
  "generation_framework_relationships",
  "generation_framework_classifications",
  "generation_framework_diagnostics",
  "generation_framework_coverage",
  "generation_framework_state",
] as const;

const FRAMEWORK_INDEXES = [
  "idx_generation_framework_entities_generation",
  "idx_generation_framework_entities_tuple",
  "idx_generation_framework_relationships_generation",
  "idx_generation_framework_classifications_generation",
  "idx_generation_framework_diagnostics_generation",
  "idx_generation_framework_coverage_generation",
  "idx_generation_framework_state_generation",
] as const;

const HISTORICAL_SCHEMA1_MISSING_TABLES = [
  "repository_index_state",
  "fact_blobs",
  "index_generations",
  "generation_symbols",
  "generation_edges",
  "generation_graph_resolution_files",
] as const;

const CURRENT_TABLES = [
  "repositories",
  "files",
  "file_capability_state",
  "symbols",
  "edges",
  "graph_resolution_files",
  "index_versions",
  "lexical_documents",
  "semantic_vector_config",
  "semantic_vectors",
  "fact_blobs",
  "repository_index_state",
  "index_generations",
  "index_manifests",
  "file_fact_bindings",
  "generation_symbols",
  "generation_edges",
  "generation_graph_resolution_files",
  "generation_lexical_documents",
  "generation_semantic_vectors",
  ...FRAMEWORK_TABLES,
] as const;

type Fixture = {
  root: string;
  dbPath: string;
};

function createHistoricalSchema1(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE atlas_schema (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version TEXT NOT NULL
    );
    INSERT INTO atlas_schema (id, version) VALUES (1, '1');

    CREATE TABLE repositories (
      id TEXT PRIMARY KEY,
      identity_key TEXT NOT NULL UNIQUE,
      root_path TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE files (
      repository_id TEXT NOT NULL,
      path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      language TEXT,
      parser_status TEXT,
      indexed_at TEXT NOT NULL,
      PRIMARY KEY (repository_id, path),
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE file_capability_state (
      repository_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      capability TEXT NOT NULL CHECK (capability IN ('graph', 'lexical', 'semantic', 'metrics')),
      file_hash TEXT,
      version TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('ready', 'disabled', 'not_configured', 'unavailable', 'error', 'stale')),
      generation TEXT,
      item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
      last_error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (repository_id, file_path, capability),
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE symbols (
      id TEXT NOT NULL,
      repository_id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT,
      file_path TEXT NOT NULL,
      start_line INTEGER,
      end_line INTEGER,
      PRIMARY KEY (repository_id, id),
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE edges (
      repository_id TEXT NOT NULL,
      owner_file TEXT NOT NULL,
      from_symbol_id TEXT NOT NULL,
      to_symbol_id TEXT NOT NULL,
      type TEXT NOT NULL,
      PRIMARY KEY (repository_id, owner_file, from_symbol_id, to_symbol_id, type),
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE index_versions (
      repository_id TEXT NOT NULL,
      axis TEXT NOT NULL CHECK (axis IN ('schema', 'parser', 'graph', 'lexical', 'semantic', 'metrics')),
      version TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (repository_id, axis),
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE INDEX idx_files_repo ON files (repository_id);
    CREATE INDEX idx_capability_repo ON file_capability_state (repository_id, capability);
    CREATE INDEX idx_symbols_repo_file ON symbols (repository_id, file_path);
    CREATE INDEX idx_symbols_repo_name ON symbols (repository_id, name);
    CREATE INDEX idx_symbols_repo_qualified_name ON symbols (repository_id, qualified_name);
    CREATE INDEX idx_edges_repo_owner ON edges (repository_id, owner_file);
    CREATE INDEX idx_edges_repo_from ON edges (repository_id, from_symbol_id, type);
    CREATE INDEX idx_edges_repo_to ON edges (repository_id, to_symbol_id, type);

    CREATE VIRTUAL TABLE lexical_documents USING fts5(
      repository_id UNINDEXED,
      document_id UNINDEXED,
      file,
      symbol_name,
      qualified_name,
      symbol_type,
      content,
      start_line UNINDEXED,
      end_line UNINDEXED,
      tokenize = 'unicode61 remove_diacritics 1'
    );
  `);
}

async function createFixture(version: SchemaVersion, conflict = false): Promise<Fixture> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14c-schema-"));
  const dbPath = path.join(root, "atlas.db");
  const database = new DatabaseSync(dbPath);
  if (version === "1") {
    createHistoricalSchema1(database);
    database.exec(`
      INSERT INTO repositories VALUES ('repo', 'repo:key', '.', 'repo', 'created', 'updated');
      INSERT INTO files VALUES ('repo', 'src/index.ts', 'file-hash', 'typescript', 'ok', 'indexed');
      INSERT INTO symbols VALUES ('source', 'repo', 'function', 'source', 'source', 'src/index.ts', 1, 2);
      INSERT INTO symbols VALUES ('target', 'repo', 'function', 'target', 'target', 'src/index.ts', 4, 5);
      INSERT INTO edges VALUES ('repo', 'src/index.ts', 'source', 'target', 'calls');
    `);
  } else {
    initializeAtlasSchema(database);
    database.exec(`
      INSERT INTO repositories VALUES ('repo', 'repo:key', '.', 'repo', 'created', 'updated');
      INSERT INTO files VALUES ('repo', 'src/index.ts', 'file-hash', 'typescript', 'ok', 'indexed');
      INSERT INTO symbols VALUES ('source', 'repo', 'function', 'source', 'source', 'src/index.ts', 1, 2);
      INSERT INTO symbols VALUES ('target', 'repo', 'function', 'target', 'target', 'src/index.ts', 4, 5);
      INSERT INTO edges (repository_id, owner_file, from_symbol_id, to_symbol_id, type, resolution_method, evidence_kind, confidence, resolution_file, resolution_line)
        VALUES ('repo', 'src/index.ts', 'source', 'target', 'calls', 'same_file', 'INFERRED', 0.9, 'src/index.ts', 2);
      INSERT INTO index_generations VALUES ('generation', 'repo', NULL, 'committed', '{}', 'created');
      INSERT INTO generation_symbols VALUES ('repo', 'generation', 'source', 'function', 'source', 'source', 'src/index.ts', 1, 2);
      INSERT INTO generation_symbols VALUES ('repo', 'generation', 'target', 'function', 'target', 'target', 'src/index.ts', 4, 5);
      INSERT INTO generation_edges (repository_id, generation_id, owner_file, from_symbol_id, to_symbol_id, type, resolution_method, evidence_kind, confidence, resolution_file, resolution_line)
        VALUES ('repo', 'generation', 'src/index.ts', 'source', 'target', 'calls', 'same_file', 'INFERRED', 0.9, 'src/index.ts', 2);
      INSERT INTO repository_index_state (
        repository_id, active_generation_id, active_schema_version, active_facts_version,
        active_facts_schema_version, active_framework_resolution_version,
        active_resolution_version, active_derived_version, active_provenance_metadata
      ) VALUES ('repo', 'generation', '${version}', 'facts-preserved', 'facts-schema-preserved', NULL, 'resolution', 'derived', '{}');
    `);
    database.exec("BEGIN IMMEDIATE;");
    try {
      for (const index of FRAMEWORK_INDEXES) database.exec(`DROP INDEX ${index}`);
      for (const table of FRAMEWORK_TABLES) database.exec(`DROP TABLE ${table}`);
      database.exec("ALTER TABLE repository_index_state DROP COLUMN active_framework_resolution_version");
      database.prepare("UPDATE atlas_schema SET version = ? WHERE id = 1").run(version);
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }
  if (conflict) {
    database.exec("CREATE VIEW generation_framework_entities AS SELECT 1 AS conflict;");
  }
  database.close();
  return { root, dbPath };
}

async function snapshotDbFiles(dbPath: string): Promise<Readonly<Record<string, string>>> {
  const snapshot: Record<string, string> = {};
  for (const suffix of ["", "-wal", "-shm"]) {
    const filePath = `${dbPath}${suffix}`;
    try {
      const metadata = await stat(filePath);
      const entry = await lstat(filePath);
      const digest = createHash("sha256").update(await readFile(filePath)).digest("hex");
      snapshot[suffix || "db"] = JSON.stringify({
        mtimeMs: metadata.mtimeMs,
        ctimeMs: metadata.ctimeMs,
        size: entry.size,
        digest,
      });
    } catch {
      snapshot[suffix || "db"] = "missing";
    }
  }
  return snapshot;
}

function tableColumns(database: DatabaseSync, table: string): string[] {
  return (database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map((row) => row.name);
}

test("new schema initialization rolls back metadata and all DDL after a conflict", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE VIEW generation_framework_entities AS SELECT 1 AS conflict;");

  assert.throws(() => initializeAtlasSchema(database), /views may not be indexed|already exists/);
  assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'atlas_schema'").get(), undefined);
  assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'repositories'").get(), undefined);
  assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'generation_framework_state'").get(), undefined);
  assert.notEqual(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'view' AND name = 'generation_framework_entities'").get(), undefined);
  database.close();
});

async function withFixture(
  version: SchemaVersion,
  run: (fixture: Fixture) => void | Promise<void>,
  conflict = false,
): Promise<void> {
  const fixture = await createFixture(version, conflict);
  try {
    await run(fixture);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
}

test("new Atlas databases use schema 3 and contain generation framework storage", () => {
  const database = new DatabaseSync(":memory:");
  initializeAtlasSchema(database);

  assert.equal(ATLAS_SCHEMA_VERSION, "3");
  assert.equal(INDEX_SCHEMA_VERSION, "2.0.0");
  assert.equal((database.prepare("SELECT version FROM atlas_schema WHERE id = 1").get() as { version: string }).version, "3");
  for (const table of FRAMEWORK_TABLES) {
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined, true, table);
  }
  assert.equal(tableColumns(database, "repository_index_state").includes("active_framework_resolution_version"), true);
  assert.deepEqual(tableColumns(database, "generation_framework_entities"), [
    "repository_id", "generation_id", "entity_key", "framework", "kind", "logical_key", "payload_json",
  ]);
  assert.deepEqual(tableColumns(database, "generation_framework_state"), [
    "repository_id", "generation_id", "framework_resolution_version", "config_json", "detections_json", "dependencies_json", "complete",
  ]);
  database.close();
});

test("schema 1 and schema 2 read-only opens preserve database, WAL, and SHM files", async () => {
  for (const version of ["1", "2"] as const) {
    await withFixture(version, async ({ dbPath }) => {
      const before = await snapshotDbFiles(dbPath);
      const store = new AtlasStore(dbPath, { readOnly: true });
      store.close();
      assert.deepEqual(await snapshotDbFiles(dbPath), before);
    });
  }
});

test("schema 1 fixture reflects the historical pre-generation storage shape", async () => {
  await withFixture("1", ({ dbPath }) => {
    const database = new DatabaseSync(dbPath, { readOnly: true });
    for (const table of HISTORICAL_SCHEMA1_MISSING_TABLES) {
      assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table), undefined, table);
    }
    database.close();
  });
});

test("writable schema 1 and schema 2 migrations finish at schema 3 exactly once", async () => {
  for (const version of ["1", "2"] as const) {
    await withFixture(version, async ({ dbPath }) => {
      const first = new AtlasStore(dbPath);
      first.close();

      const migrated = new DatabaseSync(dbPath, { readOnly: true });
      assert.equal((migrated.prepare("SELECT version FROM atlas_schema WHERE id = 1").get() as { version: string }).version, "3");
      const state = migrated.prepare("SELECT active_framework_resolution_version, active_facts_version FROM repository_index_state WHERE repository_id = 'repo'").get() as { active_framework_resolution_version: string | null; active_facts_version: string } | undefined;
      if (version === "1") {
        assert.equal(state, undefined);
      } else {
        assert.equal(state?.active_framework_resolution_version, null);
        assert.equal(state?.active_facts_version, "facts-preserved");
      }
      for (const table of CURRENT_TABLES) {
        assert.equal(migrated.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined, true, table);
      }
      migrated.close();

      const second = new AtlasStore(dbPath);
      second.close();
      const afterSecondMigration = new DatabaseSync(dbPath, { readOnly: true });
      assert.equal((afterSecondMigration.prepare("SELECT count(*) AS count FROM generation_framework_entities").get() as { count: number }).count, 0);
      afterSecondMigration.close();
    });
  }
});

test("unknown schema versions are refused without read-only mutation", async () => {
  const fixture = await createFixture("1");
  try {
    const database = new DatabaseSync(fixture.dbPath);
    database.prepare("UPDATE atlas_schema SET version = '999' WHERE id = 1").run();
    database.close();
    const before = await snapshotDbFiles(fixture.dbPath);

    assert.throws(() => new AtlasStore(fixture.dbPath, { readOnly: true }), /Unsupported AtlasStore schema version: 999/);
    assert.deepEqual(await snapshotDbFiles(fixture.dbPath), before);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});

test("failed migration DDL rolls back all schema changes", async () => {
  await withFixture("2", ({ dbPath }) => {
    const database = new DatabaseSync(dbPath);
    assert.throws(() => migrateAtlasSchema(database), /views may not be indexed|already exists/);
    assert.equal((database.prepare("SELECT version FROM atlas_schema WHERE id = 1").get() as { version: string }).version, "2");
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'generation_framework_relationships'").get(), undefined);
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'generation_framework_state'").get(), undefined);
    database.close();
  }, true);
});

test("framework entity tuples are unique and every generation table has an index", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("PRAGMA foreign_keys = ON;");
  initializeAtlasSchema(database);
  database.exec(`
    INSERT INTO repositories VALUES ('repo', 'repo:key', '.', 'repo', 'created', 'updated');
    INSERT INTO index_generations VALUES ('generation', 'repo', NULL, 'committed', '{}', 'created');
    INSERT INTO generation_framework_entities VALUES ('repo', 'generation', 'entity-a', 'next', 'route', '["app","router","/users","GET",[],null]', '{}');
  `);
  assert.throws(() => database.exec("INSERT INTO generation_framework_entities VALUES ('repo', 'generation', 'entity-b', 'next', 'route', '[\"app\",\"router\",\"/users\",\"GET\",[],null]', '{}')"));
  for (const index of FRAMEWORK_INDEXES) {
    assert.equal(database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?").get(index) !== undefined, true, index);
  }
  database.close();
});

test("read-only validation accepts all supported schema versions", () => {
  const database = new DatabaseSync(":memory:");
  database.exec("CREATE TABLE atlas_schema (id INTEGER PRIMARY KEY, version TEXT NOT NULL);");
  for (const version of ["1", "2", "3"]) {
    database.prepare("INSERT INTO atlas_schema VALUES (1, ?)").run(version);
    validateAtlasSchemaForReadOnly(database);
    database.prepare("DELETE FROM atlas_schema").run();
  }
  database.close();
});
