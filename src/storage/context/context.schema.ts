import type { DatabaseSync } from "node:sqlite";

export const CONTEXT_SCHEMA_VERSION = 2;

export class UnsupportedContextSchemaError extends Error {
  constructor(version: string) {
    super(`Unsupported context schema version: ${version}`);
    this.name = "UnsupportedContextSchemaError";
  }
}

export class InvalidContextSchemaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidContextSchemaError";
  }
}

function lifecycleTableSql(): string {
  return `CREATE TABLE IF NOT EXISTS task_context_lifecycles (
    task_context_id TEXT PRIMARY KEY,
    repository_identity TEXT NOT NULL,
    workspace_identity TEXT NOT NULL,
    session_id TEXT NOT NULL REFERENCES context_sessions(session_id),
    context_generation TEXT NOT NULL,
    task TEXT NOT NULL,
    anchors_json TEXT NOT NULL,
    task_intent_identity TEXT NOT NULL,
    latest_task_identity TEXT,
    max_items INTEGER NOT NULL,
    max_estimated_tokens INTEGER NOT NULL,
    ttl_seconds INTEGER NOT NULL,
    latest_plan_identity TEXT,
    revision INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'expired', 'closed')),
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL,
    expires_at TEXT,
    closed_at TEXT,
    schema_version INTEGER NOT NULL
  );`;
}

function validateV2Shape(database: DatabaseSync): void {
  const required = {
    context_metadata: ["key", "value"],
    context_sessions: ["session_id", "repository_identity", "workspace_identity", "consumer_json", "created_at", "last_seen_at", "context_generation", "schema_version"],
    context_snapshots: ["snapshot_id", "receipt_id", "subject_identity", "projection_identity", "content", "content_identity", "created_at", "schema_version"],
    context_receipts: ["receipt_id", "session_id", "repository_identity", "workspace_identity", "subject_json", "subject_identity", "projection_identity", "context_generation", "delivery_mode", "delivered_content_identity", "snapshot_id", "reliability_json", "delivered_at", "expires_at", "prior_receipt_id", "state", "schema_version"],
    task_context_lifecycles: ["task_context_id", "repository_identity", "workspace_identity", "session_id", "context_generation", "task", "anchors_json", "task_intent_identity", "latest_task_identity", "max_items", "max_estimated_tokens", "ttl_seconds", "latest_plan_identity", "revision", "state", "created_at", "last_seen_at", "expires_at", "closed_at", "schema_version"],
  };
  for (const [table, columns] of Object.entries(required)) {
    const present = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!present) throw new InvalidContextSchemaError(`Missing context schema table: ${table}`);
    const actual = new Set(database.prepare(`PRAGMA table_info(${table})`).all().map((row) => (row as { name: string }).name));
    for (const column of columns) if (!actual.has(column)) throw new InvalidContextSchemaError(`Missing context schema column: ${table}.${column}`);
  }
  if (!database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'index' AND name = 'context_receipts_latest_idx'").get()) throw new InvalidContextSchemaError("Missing context schema index: context_receipts_latest_idx");
}

export function initializeContextSchema(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON;");
  const metadataExists = database.prepare("SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'context_metadata'").get() as { present?: number } | undefined;
  if (metadataExists) {
    const version = database.prepare("SELECT value FROM context_metadata WHERE key = 'contextSchemaVersion'").get() as { value?: string } | undefined;
    if (version?.value !== "1" && version?.value !== String(CONTEXT_SCHEMA_VERSION)) throw new UnsupportedContextSchemaError(version?.value ?? "missing");
    if (version.value === String(CONTEXT_SCHEMA_VERSION)) { validateV2Shape(database); return; }
  }

  database.exec("BEGIN IMMEDIATE;");
  try {
    database.exec(`
    CREATE TABLE IF NOT EXISTS context_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS context_sessions (
      session_id TEXT PRIMARY KEY,
      repository_identity TEXT NOT NULL,
      workspace_identity TEXT NOT NULL,
      consumer_json TEXT,
      created_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL,
      context_generation TEXT NOT NULL,
      schema_version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS context_snapshots (
      snapshot_id TEXT PRIMARY KEY,
      receipt_id TEXT NOT NULL,
      subject_identity TEXT NOT NULL,
      projection_identity TEXT NOT NULL,
      content TEXT NOT NULL,
      content_identity TEXT NOT NULL,
      created_at TEXT NOT NULL,
      schema_version INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS context_receipts (
      receipt_id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES context_sessions(session_id),
      repository_identity TEXT NOT NULL,
      workspace_identity TEXT NOT NULL,
      subject_json TEXT NOT NULL,
      subject_identity TEXT NOT NULL,
      projection_identity TEXT NOT NULL,
      context_generation TEXT NOT NULL,
      delivery_mode TEXT NOT NULL CHECK (delivery_mode IN ('full', 'unchanged', 'delta', 'rehydrate')),
      delivered_content_identity TEXT NOT NULL,
      snapshot_id TEXT NOT NULL REFERENCES context_snapshots(snapshot_id),
      reliability_json TEXT NOT NULL,
      delivered_at TEXT NOT NULL,
      expires_at TEXT,
      prior_receipt_id TEXT,
      state TEXT NOT NULL CHECK (state IN ('active', 'expired', 'invalid')),
      schema_version INTEGER NOT NULL
    );
    ${lifecycleTableSql()}
    CREATE INDEX IF NOT EXISTS context_receipts_latest_idx ON context_receipts(session_id, subject_identity, projection_identity, delivered_at, receipt_id);
    INSERT OR IGNORE INTO context_metadata(key, value) VALUES ('contextSchemaVersion', '${CONTEXT_SCHEMA_VERSION}');
    UPDATE context_metadata SET value = '${CONTEXT_SCHEMA_VERSION}' WHERE key = 'contextSchemaVersion';
  `);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
