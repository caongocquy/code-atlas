import type { DatabaseSync } from "node:sqlite";

export const ATLAS_SCHEMA_VERSION = "1";

type SchemaRow = {
  version: string;
};

export function initializeAtlasSchema(database: DatabaseSync): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS atlas_schema (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      version TEXT NOT NULL
    );
  `);

  const row = database
    .prepare("SELECT version FROM atlas_schema WHERE id = 1")
    .get() as SchemaRow | undefined;

  if (row && row.version !== ATLAS_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported AtlasStore schema version: ${row.version}; expected ${ATLAS_SCHEMA_VERSION}`,
    );
  }

  if (!row) {
    database
      .prepare("INSERT INTO atlas_schema (id, version) VALUES (1, ?)")
      .run(ATLAS_SCHEMA_VERSION);
  }

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
      PRIMARY KEY (repository_id, generation_id, owner_file, from_symbol_id, to_symbol_id, type),
      FOREIGN KEY (generation_id) REFERENCES index_generations(id) ON DELETE CASCADE
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

    CREATE INDEX IF NOT EXISTS idx_generation_symbols_active
      ON generation_symbols (repository_id, generation_id, file_path);
    CREATE INDEX IF NOT EXISTS idx_generation_edges_active
      ON generation_edges (repository_id, generation_id, owner_file);
    CREATE INDEX IF NOT EXISTS idx_generation_lexical_active
      ON generation_lexical_documents (repository_id, generation_id, file);
  `);

  const capabilityColumns = database
    .prepare("PRAGMA table_info(file_capability_state)")
    .all() as Array<{ name: string }>;

  if (!capabilityColumns.some((column) => column.name === "file_hash")) {
    database.exec("BEGIN IMMEDIATE;");

    try {
      database.exec("ALTER TABLE file_capability_state ADD COLUMN file_hash TEXT;");
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
      database.exec("COMMIT;");
    } catch (error) {
      database.exec("ROLLBACK;");
      throw error;
    }
  }

  if (!capabilityColumns.some((column) => column.name === "provider_identity")) {
    database.exec("ALTER TABLE file_capability_state ADD COLUMN provider_identity TEXT;");
  }

  const edgeColumns = database
    .prepare("PRAGMA table_info(edges)")
    .all() as Array<{ name: string }>;

  if (!edgeColumns.some((column) => column.name === "resolution_method")) {
    database.exec("ALTER TABLE edges ADD COLUMN resolution_method TEXT;");
  }
  if (!edgeColumns.some((column) => column.name === "evidence_kind")) {
    database.exec("ALTER TABLE edges ADD COLUMN evidence_kind TEXT;");
  }
  if (!edgeColumns.some((column) => column.name === "confidence")) {
    database.exec("ALTER TABLE edges ADD COLUMN confidence REAL;");
  }
  if (!edgeColumns.some((column) => column.name === "resolution_file")) {
    database.exec("ALTER TABLE edges ADD COLUMN resolution_file TEXT;");
  }
  if (!edgeColumns.some((column) => column.name === "resolution_line")) {
    database.exec("ALTER TABLE edges ADD COLUMN resolution_line INTEGER;");
  }
}
