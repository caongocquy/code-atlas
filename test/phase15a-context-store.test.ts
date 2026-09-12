import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { ContextStore, CONTEXT_SCHEMA_VERSION } from "../src/storage/context/context.store.js";
import type { ContextReceipt, ContextSession, DeliveredSnapshot } from "../src/core/context/context.types.js";

function session(): ContextSession {
  return {
    sessionId: "session-1", repositoryIdentity: "repo-1", workspaceIdentity: "workspace-1",
    createdAt: "2026-09-12T00:00:00.000Z", lastSeenAt: "2026-09-12T00:00:00.000Z",
    contextGeneration: "context-1", schemaVersion: 1,
  };
}

function receipt(): ContextReceipt {
  return {
    receiptId: "receipt-1", sessionId: "session-1", repositoryIdentity: "repo-1", workspaceIdentity: "workspace-1",
    subject: { kind: "file", path: "src/index.ts" }, subjectIdentity: "subject-1", projectionIdentity: "projection-1",
    contextGeneration: "context-1", deliveryMode: "full", deliveredContentIdentity: "content-1", snapshotId: "snapshot-1",
    reliability: { mayBeIncomplete: false }, deliveredAt: "2026-09-12T00:00:00.000Z", state: "active", schemaVersion: 1,
  };
}

function snapshot(): DeliveredSnapshot {
  return {
    snapshotId: "snapshot-1", receiptId: "receipt-1", subjectIdentity: "subject-1", projectionIdentity: "projection-1",
    content: "hello", contentIdentity: "content-1", createdAt: "2026-09-12T00:00:00.000Z", schemaVersion: 1,
  };
}

test("context store persists sessions and atomically publishes receipt with snapshot", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15a-store-"));
  const databasePath = path.join(root, ".codeatlas", "context.db");
  try {
    const first = new ContextStore(databasePath);
    first.saveSession(session());
    first.publish(session(), receipt(), snapshot());
    first.close();

    const second = new ContextStore(databasePath);
    assert.equal(second.schemaVersion, CONTEXT_SCHEMA_VERSION);
    assert.deepEqual(second.getSession("session-1"), session());
    assert.deepEqual(second.getReceipt("receipt-1"), receipt());
    assert.deepEqual(second.getSnapshot("snapshot-1"), snapshot());
    second.close();

    const database = new DatabaseSync(databasePath);
    try {
      assert.equal((database.prepare("SELECT value FROM context_metadata WHERE key = 'contextSchemaVersion'").get() as { value: string }).value, String(CONTEXT_SCHEMA_VERSION));
    } finally { database.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("context store rejects a receipt whose snapshot is absent and rolls back the transaction", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15a-store-rollback-"));
  const databasePath = path.join(root, "context.db");
  try {
    const store = new ContextStore(databasePath);
    assert.throws(() => store.publish(session(), receipt(), { ...snapshot(), snapshotId: "wrong" }), /snapshot|receipt/i);
    assert.equal(store.getReceipt("receipt-1"), undefined);
    assert.equal(store.getSnapshot("snapshot-1"), undefined);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
