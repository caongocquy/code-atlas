import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { contentIdentity } from "../src/core/context/context-snapshot.js";
import type { ContextReceipt, ContextSession, DeliveredSnapshot } from "../src/core/context/context.types.js";
import { TaskContextLifecycleDomainError } from "../src/core/context/task-context-lifecycle.types.js";
import type { TaskContextLifecycle, TaskContextLifecycleOperation } from "../src/core/context/task-context-lifecycle.types.js";
import { ContextStore } from "../src/storage/context/context.store.js";

const expiryOperation: TaskContextLifecycleOperation = "expire";

const session: ContextSession = { sessionId: "session-1", repositoryIdentity: "repo-1", workspaceIdentity: "workspace-1", createdAt: "2026-09-13T00:00:00.000Z", lastSeenAt: "2026-09-13T00:00:00.000Z", contextGeneration: "generation-1", schemaVersion: 1 };
const receipt: ContextReceipt = { receiptId: "receipt-1", sessionId: "session-1", repositoryIdentity: "repo-1", workspaceIdentity: "workspace-1", subject: { kind: "file", path: "src/index.ts" }, subjectIdentity: "subject-1", projectionIdentity: "projection-1", contextGeneration: "generation-1", deliveryMode: "full", deliveredContentIdentity: contentIdentity("hello"), snapshotId: "snapshot-1", reliability: { mayBeIncomplete: false }, deliveredAt: "2026-09-13T00:00:00.000Z", state: "active", schemaVersion: 1 };
const snapshot: DeliveredSnapshot = { snapshotId: "snapshot-1", receiptId: "receipt-1", subjectIdentity: "subject-1", projectionIdentity: "projection-1", content: "hello", contentIdentity: contentIdentity("hello"), createdAt: "2026-09-13T00:00:00.000Z", schemaVersion: 1 };
type StoredLifecycle = TaskContextLifecycle & { taskIntentIdentity: string };
const lifecycle: StoredLifecycle = { taskContextId: "00000000-0000-4000-8000-000000000001", repositoryIdentity: "repo-1", workspaceIdentity: "workspace-1", sessionId: "session-1", contextGeneration: "generation-1", task: "find it", anchors: [{ kind: "file", path: "src/index.ts" }], taskIdentity: "phase15b-task-1", taskIntentIdentity: "task-intent-v1:identity", defaultBudget: { maxItems: 20, maxEstimatedTokens: 4000 }, ttlSeconds: 86400, revision: 0, state: "active", createdAt: session.createdAt, lastSeenAt: session.lastSeenAt, schemaVersion: 2 };

test("lifecycle start persists revision one and refresh CAS conflict does not publish", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-store-"));
  try {
    const store = new ContextStore(path.join(root, "context.db"));
    const started = store.createAndCommitStart({ lifecycle, session, prepared: [{ session, receipt, snapshot }] });
    assert.equal(started.revision, 1);
    assert.equal((started as StoredLifecycle).taskIntentIdentity, "task-intent-v1:identity");
    assert.equal(started.taskIdentity, "phase15b-task-1");
    assert.equal(store.loadLifecycle(lifecycle.taskContextId)?.revision, 1);
    assert.throws(() => store.commitRefresh({ taskContextId: lifecycle.taskContextId, expectedRevision: 0, now: "2026-09-13T00:01:00.000Z", repositoryIdentity: "repo-1", workspaceIdentity: "workspace-1", prepared: [{ session, receipt: { ...receipt, receiptId: "receipt-2", snapshotId: "snapshot-2" }, snapshot: { ...snapshot, receiptId: "receipt-2", snapshotId: "snapshot-2" } }], latestTaskIdentity: "task-2", latestPlanIdentity: "plan-2" }), (error: unknown) => error instanceof TaskContextLifecycleDomainError && error.operationError.code === "lifecycle_conflict");
    assert.equal(store.loadLifecycle(lifecycle.taskContextId)?.revision, 1);
    assert.equal((store as unknown as { database: { prepare(sql: string): { get(): { count: number } } } }).database.prepare("SELECT count(*) AS count FROM context_receipts").get().count, 1);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("close is idempotent and does not change an expired lifecycle", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-store-state-"));
  try {
    const store = new ContextStore(path.join(root, "context.db"));
    store.createAndCommitStart({ lifecycle, session, prepared: [] });
    const closed = store.closeLifecycle({ taskContextId: lifecycle.taskContextId, expectedRevision: 1, now: "2026-09-13T00:01:00.000Z", repositoryIdentity: "repo-1", workspaceIdentity: "workspace-1" });
    assert.equal(closed.state, "closed");
    assert.deepEqual(store.closeLifecycle({ taskContextId: lifecycle.taskContextId, expectedRevision: 2, now: "2026-09-13T00:02:00.000Z", repositoryIdentity: "repo-1", workspaceIdentity: "workspace-1" }), closed);
    store.close();

    const expiredRoot = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-store-expired-"));
    try {
      const expiredStore = new ContextStore(path.join(expiredRoot, "context.db"));
      expiredStore.createAndCommitStart({ lifecycle: { ...lifecycle, taskContextId: "00000000-0000-4000-8000-000000000002" }, session, prepared: [] });
      const expired = expiredStore.expireLifecycle({ taskContextId: "00000000-0000-4000-8000-000000000002", expectedRevision: 1, now: "2026-09-13T00:03:00.000Z", repositoryIdentity: "repo-1", workspaceIdentity: "workspace-1" });
      assert.equal(expiryOperation, "expire");
      assert.throws(() => expiredStore.expireLifecycle({ taskContextId: expired.taskContextId, expectedRevision: expired.revision, now: "2026-09-13T00:04:00.000Z", repositoryIdentity: "repo-1", workspaceIdentity: "workspace-1" }), (error: unknown) => error instanceof TaskContextLifecycleDomainError && error.operationError.operation === "expire" && error.operationError.code === "context_expired");
      assert.equal(expiredStore.closeLifecycle({ taskContextId: expired.taskContextId, expectedRevision: expired.revision, now: "2026-09-13T00:04:00.000Z", repositoryIdentity: "repo-1", workspaceIdentity: "workspace-1" }).state, "expired");
      expiredStore.close();
    } finally { await rm(expiredRoot, { recursive: true, force: true }); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("start rejects lifecycle/session identity and state mismatches at the storage boundary", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-store-invariants-"));
  try {
    const store = new ContextStore(path.join(root, "context.db"));
    assert.throws(() => store.createAndCommitStart({ lifecycle: { ...lifecycle, repositoryIdentity: "other-repo" }, session, prepared: [] }), /identity|repository|workspace/i);
    assert.throws(() => store.createAndCommitStart({ lifecycle: { ...lifecycle, sessionId: "other-session" }, session, prepared: [] }), /identity|session/i);
    assert.throws(() => store.createAndCommitStart({ lifecycle: { ...lifecycle, state: "closed" }, session, prepared: [] }), /active|state/i);
    assert.throws(() => store.createAndCommitStart({ lifecycle: { ...lifecycle, revision: 1 }, session, prepared: [] }), /revision/i);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refresh rejects a publication from another lifecycle without writing history", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-store-publication-"));
  try {
    const store = new ContextStore(path.join(root, "context.db"));
    store.createAndCommitStart({ lifecycle, session, prepared: [] });
    const otherSession = { ...session, sessionId: "session-2", contextGeneration: "generation-2" };
    assert.throws(() => store.commitRefresh({ taskContextId: lifecycle.taskContextId, expectedRevision: 1, now: "2026-09-13T00:05:00.000Z", repositoryIdentity: "repo-1", workspaceIdentity: "workspace-1", prepared: [{ session: otherSession, receipt: { ...receipt, receiptId: "receipt-2", sessionId: "session-2", contextGeneration: "generation-2", snapshotId: "snapshot-2" }, snapshot: { ...snapshot, receiptId: "receipt-2", snapshotId: "snapshot-2" } }], latestTaskIdentity: "phase15b-task-2", latestPlanIdentity: "plan-2" }), /publication|lifecycle|identity/i);
    assert.equal(store.loadLifecycle(lifecycle.taskContextId)?.revision, 1);
    assert.equal((store as unknown as { database: { prepare(sql: string): { get(): { count: number } } } }).database.prepare("SELECT count(*) AS count FROM context_receipts").get().count, 0);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
