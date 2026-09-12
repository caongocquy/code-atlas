import type { DatabaseSync } from "node:sqlite";

export const CONTEXT_SCHEMA_VERSION = 1;

export function initializeContextSchema(database: DatabaseSync): void {
  database.exec("PRAGMA foreign_keys = ON;");
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
    INSERT OR IGNORE INTO context_metadata(key, value) VALUES ('contextSchemaVersion', '${CONTEXT_SCHEMA_VERSION}');
  `);
  const version = database.prepare("SELECT value FROM context_metadata WHERE key = 'contextSchemaVersion'").get() as { value?: string } | undefined;
  if (version?.value !== String(CONTEXT_SCHEMA_VERSION)) throw new Error(`Unsupported context schema version: ${version?.value ?? "missing"}`);
}
