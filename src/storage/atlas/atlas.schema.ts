import type { DatabaseSync } from "node:sqlite";

export const ATLAS_SCHEMA_VERSION = "3";
export const PREVIOUS_ATLAS_SCHEMA_VERSION = "2";
const SUPPORTED_ATLAS_SCHEMA_VERSIONS = new Set(["1", "2", ATLAS_SCHEMA_VERSION]);

export const ADD_PHASE14B_COLUMNS = [
  ["generation_edges", "resolution_strategy TEXT"],
  ["generation_edges", "resolution_confidence TEXT"],
  ["generation_edges", "resolution_evidence_json TEXT"],
  ["generation_edges", "resolution_version TEXT"],
  ["generation_edges", "resolution_source_identity TEXT"],
  ["generation_edges", "resolution_target_identity TEXT"],
  ["edges", "resolution_strategy TEXT"],
  ["edges", "resolution_confidence TEXT"],
  ["edges", "resolution_evidence_json TEXT"],
  ["edges", "resolution_version TEXT"],
  ["edges", "resolution_source_identity TEXT"],
  ["edges", "resolution_target_identity TEXT"],
  ["repository_index_state", "active_facts_schema_version TEXT"],
] as const;

type SchemaRow = {
  version: string;
};

function createCurrentSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS repositories (
      id TEXT PRIMARY KEY,
      identity_key TEXT NOT NULL UNIQUE,
      root_path TEXT NOT NULL,
      display_name TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS files (
      repository_id TEXT NOT NULL,
      path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      language TEXT,
      parser_status TEXT,
      indexed_at TEXT NOT NULL,

      PRIMARY KEY (repository_id, path),
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS file_capability_state (
      repository_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      capability TEXT NOT NULL CHECK (capability IN ('graph', 'lexical', 'semantic', 'reranker', 'metrics')),
      file_hash TEXT,
      version TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('ready', 'disabled', 'not_configured', 'unavailable', 'error', 'stale')),
      generation TEXT,
      provider_identity TEXT,
      item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
      last_error TEXT,
      updated_at TEXT NOT NULL,

      PRIMARY KEY (repository_id, file_path, capability),
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS symbols (
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

    CREATE TABLE IF NOT EXISTS edges (
      repository_id TEXT NOT NULL,
      owner_file TEXT NOT NULL,
      from_symbol_id TEXT NOT NULL,
      to_symbol_id TEXT NOT NULL,
      type TEXT NOT NULL,
      resolution_method TEXT,
      evidence_kind TEXT,
      confidence REAL,
      resolution_file TEXT,
      resolution_line INTEGER,
      resolution_strategy TEXT,
      resolution_confidence TEXT,
      resolution_evidence_json TEXT,
      resolution_version TEXT,
      resolution_source_identity TEXT,
      resolution_target_identity TEXT,

      PRIMARY KEY (repository_id, owner_file, from_symbol_id, to_symbol_id, type),
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS graph_resolution_files (
      repository_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      resolved_calls INTEGER NOT NULL DEFAULT 0,
      unresolved_calls INTEGER NOT NULL DEFAULT 0,
      ambiguous_calls INTEGER NOT NULL DEFAULT 0,
      extends_count INTEGER NOT NULL DEFAULT 0,
      resolved_extends INTEGER NOT NULL DEFAULT 0,
      unresolved_extends INTEGER NOT NULL DEFAULT 0,
      ambiguous_extends INTEGER NOT NULL DEFAULT 0,
      parser_errors INTEGER NOT NULL DEFAULT 0,
      unsupported_dynamic INTEGER NOT NULL DEFAULT 0,
      may_be_incomplete INTEGER NOT NULL DEFAULT 0,
      diagnostics_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,

      PRIMARY KEY (repository_id, file_path),
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS index_versions (
      repository_id TEXT NOT NULL,
      axis TEXT NOT NULL CHECK (axis IN ('schema', 'parser', 'graph', 'lexical', 'semantic', 'metrics')),
      version TEXT NOT NULL,
      updated_at TEXT NOT NULL,

      PRIMARY KEY (repository_id, axis),
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_files_repo
      ON files (repository_id);

    CREATE INDEX IF NOT EXISTS idx_capability_repo
      ON file_capability_state (repository_id, capability);

    CREATE INDEX IF NOT EXISTS idx_symbols_repo_file
      ON symbols (repository_id, file_path);

    CREATE INDEX IF NOT EXISTS idx_symbols_repo_name
      ON symbols (repository_id, name);

    CREATE INDEX IF NOT EXISTS idx_symbols_repo_qualified_name
      ON symbols (repository_id, qualified_name);

    CREATE INDEX IF NOT EXISTS idx_edges_repo_owner
      ON edges (repository_id, owner_file);

    CREATE INDEX IF NOT EXISTS idx_edges_repo_from
      ON edges (repository_id, from_symbol_id, type);

    CREATE INDEX IF NOT EXISTS idx_edges_repo_to
      ON edges (repository_id, to_symbol_id, type);

    CREATE INDEX IF NOT EXISTS idx_graph_resolution_repo
      ON graph_resolution_files (repository_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS lexical_documents USING fts5(
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

    CREATE TABLE IF NOT EXISTS semantic_vector_config (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      dimensions INTEGER NOT NULL CHECK (dimensions > 0)
    );

    CREATE TABLE IF NOT EXISTS semantic_vectors (
      repository_id TEXT NOT NULL,
      point_id TEXT NOT NULL,
      vector BLOB NOT NULL,
      file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,

      PRIMARY KEY (repository_id, point_id),
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS fact_blobs (
      fact_blob_key TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      language TEXT NOT NULL,
      parser_identity_json TEXT NOT NULL,
      facts_version TEXT NOT NULL,
      facts_schema_version TEXT NOT NULL,
      payload_json TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS idx_semantic_vectors_repo_file
      ON semantic_vectors (repository_id, file_path);

    CREATE INDEX IF NOT EXISTS idx_fact_blobs_content_hash
      ON fact_blobs (content_hash);

    CREATE TABLE IF NOT EXISTS repository_index_state (
      repository_id TEXT PRIMARY KEY,
      active_generation_id TEXT,
      active_schema_version TEXT NOT NULL,
      active_facts_version TEXT NOT NULL,
      active_facts_schema_version TEXT,
      active_framework_resolution_version TEXT,
      active_resolution_version TEXT NOT NULL,
      active_derived_version TEXT NOT NULL,
      active_provenance_metadata TEXT NOT NULL DEFAULT '{}',
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS index_generations (
      id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      parent_generation_id TEXT,
      status TEXT NOT NULL CHECK (status IN ('candidate', 'committed')),
      versions_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS index_manifests (
      generation_id TEXT PRIMARY KEY,
      repository_id TEXT NOT NULL,
      versions_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      FOREIGN KEY (generation_id) REFERENCES index_generations(id) ON DELETE CASCADE,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS file_fact_bindings (
      repository_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      relative_path TEXT NOT NULL,
      fact_blob_key TEXT NOT NULL,
      content_hash TEXT NOT NULL,
      language TEXT NOT NULL,
      PRIMARY KEY (repository_id, generation_id, relative_path),
      FOREIGN KEY (generation_id) REFERENCES index_generations(id) ON DELETE CASCADE,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE,
      FOREIGN KEY (fact_blob_key) REFERENCES fact_blobs(fact_blob_key)
    );

    CREATE TABLE IF NOT EXISTS generation_symbols (
      repository_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      id TEXT NOT NULL,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      qualified_name TEXT,
      file_path TEXT NOT NULL,
      start_line INTEGER,
      end_line INTEGER,
      PRIMARY KEY (repository_id, generation_id, id),
      FOREIGN KEY (generation_id) REFERENCES index_generations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS generation_edges (
      repository_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      owner_file TEXT NOT NULL,
      from_symbol_id TEXT NOT NULL,
      to_symbol_id TEXT NOT NULL,
      type TEXT NOT NULL,
      resolution_method TEXT,
      evidence_kind TEXT,
      confidence REAL,
      resolution_file TEXT,
      resolution_line INTEGER,
      resolution_strategy TEXT,
      resolution_confidence TEXT,
      resolution_evidence_json TEXT,
      resolution_version TEXT,
      resolution_source_identity TEXT,
      resolution_target_identity TEXT,
      PRIMARY KEY (repository_id, generation_id, owner_file, from_symbol_id, to_symbol_id, type),
      FOREIGN KEY (generation_id) REFERENCES index_generations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS generation_graph_resolution_files (
      repository_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      calls INTEGER NOT NULL DEFAULT 0,
      resolved_calls INTEGER NOT NULL DEFAULT 0,
      unresolved_calls INTEGER NOT NULL DEFAULT 0,
      ambiguous_calls INTEGER NOT NULL DEFAULT 0,
      extends_count INTEGER NOT NULL DEFAULT 0,
      resolved_extends INTEGER NOT NULL DEFAULT 0,
      unresolved_extends INTEGER NOT NULL DEFAULT 0,
      ambiguous_extends INTEGER NOT NULL DEFAULT 0,
      parser_errors INTEGER NOT NULL DEFAULT 0,
      unsupported_dynamic INTEGER NOT NULL DEFAULT 0,
      may_be_incomplete INTEGER NOT NULL DEFAULT 0,
      diagnostics_json TEXT NOT NULL DEFAULT '[]',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (repository_id, generation_id, file_path),
      FOREIGN KEY (generation_id) REFERENCES index_generations(id) ON DELETE CASCADE,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS generation_lexical_documents (
      repository_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      document_id TEXT NOT NULL,
      file TEXT NOT NULL,
      symbol_name TEXT,
      qualified_name TEXT,
      symbol_type TEXT,
      content TEXT NOT NULL,
      start_line INTEGER,
      end_line INTEGER,
      PRIMARY KEY (repository_id, generation_id, document_id),
      FOREIGN KEY (generation_id) REFERENCES index_generations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS generation_semantic_vectors (
      repository_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      point_id TEXT NOT NULL,
      vector BLOB NOT NULL,
      file_path TEXT NOT NULL,
      file_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (repository_id, generation_id, point_id),
      FOREIGN KEY (generation_id) REFERENCES index_generations(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS generation_framework_entities (
      repository_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      entity_key TEXT NOT NULL,
      framework TEXT NOT NULL,
      kind TEXT NOT NULL,
      logical_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (repository_id, generation_id, entity_key),
      UNIQUE (repository_id, generation_id, framework, kind, logical_key),
      FOREIGN KEY (generation_id) REFERENCES index_generations(id) ON DELETE CASCADE,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS generation_framework_relationships (
      repository_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      output_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (repository_id, generation_id, output_key),
      FOREIGN KEY (generation_id) REFERENCES index_generations(id) ON DELETE CASCADE,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS generation_framework_classifications (
      repository_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      subject_key TEXT NOT NULL,
      classification_kind TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (repository_id, generation_id, subject_key, classification_kind),
      FOREIGN KEY (generation_id) REFERENCES index_generations(id) ON DELETE CASCADE,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS generation_framework_diagnostics (
      repository_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      diagnostic_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (repository_id, generation_id, diagnostic_key),
      FOREIGN KEY (generation_id) REFERENCES index_generations(id) ON DELETE CASCADE,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS generation_framework_coverage (
      repository_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      dimension_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (repository_id, generation_id, dimension_key),
      FOREIGN KEY (generation_id) REFERENCES index_generations(id) ON DELETE CASCADE,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS generation_framework_state (
      repository_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      framework_resolution_version TEXT NOT NULL,
      config_json TEXT NOT NULL,
      detections_json TEXT NOT NULL,
      dependencies_json TEXT NOT NULL,
      complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
      PRIMARY KEY (repository_id, generation_id),
      FOREIGN KEY (generation_id) REFERENCES index_generations(id) ON DELETE CASCADE,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS generation_reliability_contributions (
      repository_id TEXT NOT NULL,
      generation_id TEXT NOT NULL,
      contribution_key TEXT NOT NULL,
      owner_key TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      output_key TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      PRIMARY KEY (repository_id, generation_id, contribution_key),
      UNIQUE (repository_id, generation_id, owner_key, scope_key, output_key),
      FOREIGN KEY (generation_id) REFERENCES index_generations(id) ON DELETE CASCADE,
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    DROP INDEX IF EXISTS idx_generation_framework_entities_tuple;
    CREATE INDEX IF NOT EXISTS idx_generation_symbols_active
      ON generation_symbols (repository_id, generation_id, file_path);
    CREATE INDEX IF NOT EXISTS idx_generation_edges_active
      ON generation_edges (repository_id, generation_id, owner_file);
    CREATE INDEX IF NOT EXISTS idx_generation_resolution_active
      ON generation_graph_resolution_files (repository_id, generation_id, file_path);
    CREATE INDEX IF NOT EXISTS idx_generation_lexical_active
      ON generation_lexical_documents (repository_id, generation_id, file);
    CREATE INDEX IF NOT EXISTS idx_generation_framework_entities_generation
      ON generation_framework_entities (repository_id, generation_id);
    CREATE INDEX IF NOT EXISTS idx_generation_framework_relationships_generation
      ON generation_framework_relationships (repository_id, generation_id);
    CREATE INDEX IF NOT EXISTS idx_generation_framework_classifications_generation
      ON generation_framework_classifications (repository_id, generation_id);
    CREATE INDEX IF NOT EXISTS idx_generation_framework_diagnostics_generation
      ON generation_framework_diagnostics (repository_id, generation_id);
    CREATE INDEX IF NOT EXISTS idx_generation_framework_coverage_generation
      ON generation_framework_coverage (repository_id, generation_id);
    CREATE INDEX IF NOT EXISTS idx_generation_framework_state_generation
      ON generation_framework_state (repository_id, generation_id);
    CREATE INDEX IF NOT EXISTS idx_generation_reliability_owner
      ON generation_reliability_contributions (repository_id, generation_id, owner_key);
  `);

}

function rebuildFileCapabilityStateForReranker(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE file_capability_state_migrating (
      repository_id TEXT NOT NULL,
      file_path TEXT NOT NULL,
      capability TEXT NOT NULL CHECK (capability IN ('graph', 'lexical', 'semantic', 'reranker', 'metrics')),
      file_hash TEXT,
      version TEXT NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('ready', 'disabled', 'not_configured', 'unavailable', 'error', 'stale')),
      generation TEXT,
      provider_identity TEXT,
      item_count INTEGER NOT NULL DEFAULT 0 CHECK (item_count >= 0),
      last_error TEXT,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (repository_id, file_path, capability),
      FOREIGN KEY (repository_id) REFERENCES repositories(id) ON DELETE CASCADE
    );

    INSERT INTO file_capability_state_migrating (
      repository_id, file_path, capability, file_hash, version, state,
      generation, provider_identity, item_count, last_error, updated_at
    )
    SELECT repository_id, file_path, capability, file_hash, version, state,
           generation, provider_identity, item_count, last_error, updated_at
    FROM file_capability_state;

    DROP TABLE file_capability_state;
    ALTER TABLE file_capability_state_migrating RENAME TO file_capability_state;
    CREATE INDEX idx_capability_repo
      ON file_capability_state (repository_id, capability);
  `);
}

export function initializeAtlasSchema(database: DatabaseSync): void {
  database.exec("BEGIN IMMEDIATE;");
  let transactionStarted = true;
  try {
    database.exec(`
      CREATE TABLE IF NOT EXISTS atlas_schema (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        version TEXT NOT NULL
      );
    `);

    const row = database
      .prepare("SELECT version FROM atlas_schema WHERE id = 1")
      .get() as SchemaRow | undefined;

    if (row && !SUPPORTED_ATLAS_SCHEMA_VERSIONS.has(row.version)) {
      throw new Error(
        `Unsupported AtlasStore schema version: ${row.version}; expected ${ATLAS_SCHEMA_VERSION}`,
      );
    }

    if (!row) {
      database.prepare("INSERT INTO atlas_schema (id, version) VALUES (1, ?)").run(ATLAS_SCHEMA_VERSION);
    } else if (row.version !== ATLAS_SCHEMA_VERSION) {
      database.exec("COMMIT;");
      transactionStarted = false;
      return;
    }

    createCurrentSchema(database);
    database.exec("COMMIT;");
    transactionStarted = false;
  } catch (error) {
    if (transactionStarted) {
      try {
        database.exec("ROLLBACK;");
      } catch {
        // Preserve the original initialization error.
      }
    }
    throw error;
  }
}

export function validateAtlasSchemaForReadOnly(database: DatabaseSync): void {
  const table = database
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'atlas_schema'")
    .get();
  if (!table) return;

  const row = database.prepare("SELECT version FROM atlas_schema WHERE id = 1").get() as SchemaRow | undefined;
  if (row && !SUPPORTED_ATLAS_SCHEMA_VERSIONS.has(row.version)) {
    throw new Error(`Unsupported AtlasStore schema version: ${row.version}; expected ${ATLAS_SCHEMA_VERSION}`);
  }
}

export function migrateAtlasSchema(database: DatabaseSync): void {
  const row = database.prepare("SELECT version FROM atlas_schema WHERE id = 1").get() as SchemaRow | undefined;
  if (!row) throw new Error("AtlasStore schema metadata is missing");
  if (row.version === ATLAS_SCHEMA_VERSION) return;
  if (!SUPPORTED_ATLAS_SCHEMA_VERSIONS.has(row.version)) {
    throw new Error(`Unsupported AtlasStore schema version: ${row.version}; expected ${ATLAS_SCHEMA_VERSION}`);
  }

  database.exec("BEGIN IMMEDIATE;");
  try {
    createCurrentSchema(database);

    const legacyColumns = [
      ["file_capability_state", "file_hash TEXT"],
      ["file_capability_state", "provider_identity TEXT"],
      ["edges", "resolution_method TEXT"],
      ["edges", "evidence_kind TEXT"],
      ["edges", "confidence REAL"],
      ["edges", "resolution_file TEXT"],
      ["edges", "resolution_line INTEGER"],
    ] as const;
    for (const [table, definition] of legacyColumns) {
      const column = definition.slice(0, definition.indexOf(" "));
      const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((item) => item.name === column)) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
      }
    }
    if (row.version === "1") {
      rebuildFileCapabilityStateForReranker(database);
    }
    database.exec(`
      UPDATE file_capability_state
      SET file_hash = (
        SELECT file_hash
        FROM files
        WHERE files.repository_id = file_capability_state.repository_id
          AND files.path = file_capability_state.file_path
      )
      WHERE file_hash IS NULL;
    `);

    for (const [table, definition] of ADD_PHASE14B_COLUMNS) {
      const column = definition.slice(0, definition.indexOf(" "));
      const columns = database.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      if (!columns.some((item) => item.name === column)) {
        database.exec(`ALTER TABLE ${table} ADD COLUMN ${definition}`);
      }
    }

    const repositoryStateColumns = database
      .prepare("PRAGMA table_info(repository_index_state)")
      .all() as Array<{ name: string }>;
    if (!repositoryStateColumns.some((column) => column.name === "active_framework_resolution_version")) {
      database.exec("ALTER TABLE repository_index_state ADD COLUMN active_framework_resolution_version TEXT;");
    }

    if (row.version === "1") {
      database.prepare("UPDATE atlas_schema SET version = ? WHERE id = 1").run(PREVIOUS_ATLAS_SCHEMA_VERSION);
    }
    database.prepare("UPDATE atlas_schema SET version = ? WHERE id = 1").run(ATLAS_SCHEMA_VERSION);
    database.exec("COMMIT;");
  } catch (error) {
    database.exec("ROLLBACK;");
    throw error;
  }
}
