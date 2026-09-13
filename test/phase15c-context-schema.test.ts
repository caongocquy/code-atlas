import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { ContextStore, CONTEXT_SCHEMA_VERSION, ContextStoreOpenError } from "../src/storage/context/context.store.js";
import { UnsupportedContextSchemaError } from "../src/storage/context/context.schema.js";

test("opening a v1 context database migrates to v2 without changing Phase15A rows", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-schema-"));
  const databasePath = path.join(root, "context.db");
  try {
    const database = new DatabaseSync(databasePath);
    database.exec(`
      PRAGMA foreign_keys = ON;
      CREATE TABLE context_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE context_sessions (session_id TEXT PRIMARY KEY, repository_identity TEXT NOT NULL, workspace_identity TEXT NOT NULL, consumer_json TEXT, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, context_generation TEXT NOT NULL, schema_version INTEGER NOT NULL);
      CREATE TABLE context_snapshots (snapshot_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, subject_identity TEXT NOT NULL, projection_identity TEXT NOT NULL, content TEXT NOT NULL, content_identity TEXT NOT NULL, created_at TEXT NOT NULL, schema_version INTEGER NOT NULL);
      CREATE TABLE context_receipts (receipt_id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES context_sessions(session_id), repository_identity TEXT NOT NULL, workspace_identity TEXT NOT NULL, subject_json TEXT NOT NULL, subject_identity TEXT NOT NULL, projection_identity TEXT NOT NULL, context_generation TEXT NOT NULL, delivery_mode TEXT NOT NULL, delivered_content_identity TEXT NOT NULL, snapshot_id TEXT NOT NULL REFERENCES context_snapshots(snapshot_id), reliability_json TEXT NOT NULL, delivered_at TEXT NOT NULL, expires_at TEXT, prior_receipt_id TEXT, state TEXT NOT NULL, schema_version INTEGER NOT NULL);
      INSERT INTO context_metadata VALUES ('contextSchemaVersion', '1');
      INSERT INTO context_sessions VALUES ('session-1', 'repo-1', 'workspace-1', NULL, 'created', 'seen', 'generation-1', 1);
      INSERT INTO context_snapshots VALUES ('snapshot-1', 'receipt-1', 'subject-1', 'projection-1', 'content', 'sha256:content', 'created', 1);
      INSERT INTO context_receipts VALUES ('receipt-1', 'session-1', 'repo-1', 'workspace-1', '{"kind":"file","path":"src/index.ts"}', 'subject-1', 'projection-1', 'generation-1', 'full', 'sha256:content', 'snapshot-1', '{"mayBeIncomplete":false}', 'delivered', NULL, NULL, 'active', 1);
    `);
    database.close();

    const store = new ContextStore(databasePath);
    assert.equal(store.schemaVersion, CONTEXT_SCHEMA_VERSION);
    assert.ok(store.getSession("session-1"));
    assert.ok(store.getReceipt("receipt-1"));
    assert.ok(store.getSnapshot("snapshot-1"));
    store.close();

    const migrated = new DatabaseSync(databasePath);
    assert.equal((migrated.prepare("SELECT value FROM context_metadata WHERE key = 'contextSchemaVersion'").get() as { value: string }).value, "2");
    assert.equal((migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_context_lifecycles'").get() as { name: string }).name, "task_context_lifecycles");
    assert.deepEqual(migrated.prepare("SELECT * FROM context_sessions").all().map((row) => ({ ...row })), [{ session_id: "session-1", repository_identity: "repo-1", workspace_identity: "workspace-1", consumer_json: null, created_at: "created", last_seen_at: "seen", context_generation: "generation-1", schema_version: 1 }]);
    assert.deepEqual(migrated.prepare("SELECT * FROM context_receipts").all().map((row) => ({ ...row })), [{ receipt_id: "receipt-1", session_id: "session-1", repository_identity: "repo-1", workspace_identity: "workspace-1", subject_json: '{"kind":"file","path":"src/index.ts"}', subject_identity: "subject-1", projection_identity: "projection-1", context_generation: "generation-1", delivery_mode: "full", delivered_content_identity: "sha256:content", snapshot_id: "snapshot-1", reliability_json: '{"mayBeIncomplete":false}', delivered_at: "delivered", expires_at: null, prior_receipt_id: null, state: "active", schema_version: 1 }]);
    assert.deepEqual(migrated.prepare("SELECT * FROM context_snapshots").all().map((row) => ({ ...row })), [{ snapshot_id: "snapshot-1", receipt_id: "receipt-1", subject_identity: "subject-1", projection_identity: "projection-1", content: "content", content_identity: "sha256:content", created_at: "created", schema_version: 1 }]);
    migrated.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("failed migration rolls back and leaves the original v1 database openable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-schema-rollback-"));
  const databasePath = path.join(root, "context.db");
  try {
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE context_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO context_metadata VALUES ('contextSchemaVersion', '1'); CREATE TRIGGER reject_context_version BEFORE UPDATE OF value ON context_metadata BEGIN SELECT RAISE(ABORT, 'forced migration failure'); END;");
    database.close();

    assert.throws(() => new ContextStore(databasePath));
    const reopened = new DatabaseSync(databasePath);
    assert.equal((reopened.prepare("SELECT value FROM context_metadata WHERE key = 'contextSchemaVersion'").get() as { value: string }).value, "1");
    assert.equal(reopened.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'task_context_lifecycles'").get(), undefined);
    reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("future context schema versions fail closed before migration writes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-schema-future-"));
  const databasePath = path.join(root, "context.db");
  try {
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE context_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO context_metadata VALUES ('contextSchemaVersion', '3');");
    database.close();
    assert.throws(() => new ContextStore(databasePath), UnsupportedContextSchemaError);
    const reopened = new DatabaseSync(databasePath);
    assert.equal((reopened.prepare("SELECT value FROM context_metadata WHERE key = 'contextSchemaVersion'").get() as { value: string }).value, "3");
    reopened.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a v2 database missing the lifecycle table fails with a typed open error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-schema-malformed-"));
  const databasePath = path.join(root, "context.db");
  try {
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE context_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO context_metadata VALUES ('contextSchemaVersion', '2');");
    database.close();
    assert.throws(() => new ContextStore(databasePath), ContextStoreOpenError);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("a v2 lifecycle table missing a required column or index fails closed", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-schema-shape-"));
  const databasePath = path.join(root, "context.db");
  try {
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE context_metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO context_metadata VALUES ('contextSchemaVersion', '2'); CREATE TABLE context_sessions (session_id TEXT PRIMARY KEY, repository_identity TEXT NOT NULL, workspace_identity TEXT NOT NULL, consumer_json TEXT, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, context_generation TEXT NOT NULL, schema_version INTEGER NOT NULL); CREATE TABLE context_snapshots (snapshot_id TEXT PRIMARY KEY, receipt_id TEXT NOT NULL, subject_identity TEXT NOT NULL, projection_identity TEXT NOT NULL, content TEXT NOT NULL, content_identity TEXT NOT NULL, created_at TEXT NOT NULL, schema_version INTEGER NOT NULL); CREATE TABLE context_receipts (receipt_id TEXT PRIMARY KEY, session_id TEXT NOT NULL, repository_identity TEXT NOT NULL, workspace_identity TEXT NOT NULL, subject_json TEXT NOT NULL, subject_identity TEXT NOT NULL, projection_identity TEXT NOT NULL, context_generation TEXT NOT NULL, delivery_mode TEXT NOT NULL, delivered_content_identity TEXT NOT NULL, snapshot_id TEXT NOT NULL, reliability_json TEXT NOT NULL, delivered_at TEXT NOT NULL, expires_at TEXT, prior_receipt_id TEXT, state TEXT NOT NULL, schema_version INTEGER NOT NULL); CREATE TABLE task_context_lifecycles (task_context_id TEXT PRIMARY KEY, repository_identity TEXT NOT NULL, workspace_identity TEXT NOT NULL, session_id TEXT NOT NULL, context_generation TEXT NOT NULL, task TEXT NOT NULL, anchors_json TEXT NOT NULL, task_intent_identity TEXT NOT NULL, latest_task_identity TEXT, max_items INTEGER NOT NULL, max_estimated_tokens INTEGER NOT NULL, ttl_seconds INTEGER NOT NULL, latest_plan_identity TEXT, revision INTEGER NOT NULL, state TEXT NOT NULL, created_at TEXT NOT NULL, last_seen_at TEXT NOT NULL, expires_at TEXT, schema_version INTEGER NOT NULL);");
    database.close();
    assert.throws(() => new ContextStore(databasePath), ContextStoreOpenError);

    const validRoot = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-schema-index-"));
    try {
      const validPath = path.join(validRoot, "context.db");
      const store = new ContextStore(validPath);
      store.close();
      const valid = new DatabaseSync(validPath);
      valid.exec("DROP INDEX context_receipts_latest_idx;");
      valid.close();
      assert.throws(() => new ContextStore(validPath), ContextStoreOpenError);
    } finally { await rm(validRoot, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
