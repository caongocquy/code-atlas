import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { contentIdentity } from "../src/core/context/context-snapshot.js";
import type { ContextReceipt, ContextSession, DeliveredSnapshot } from "../src/core/context/context.types.js";
import { TaskContextLifecycleDomainError } from "../src/core/context/task-context-lifecycle.types.js";
import type { TaskContextLifecycle } from "../src/core/context/task-context-lifecycle.types.js";
import { ContextStore } from "../src/storage/context/context.store.js";

const session: ContextSession = { sessionId: "session-1", repositoryIdentity: "repo-1", workspaceIdentity: "workspace-1", createdAt: "2026-09-13T00:00:00.000Z", lastSeenAt: "2026-09-13T00:00:00.000Z", contextGeneration: "generation-1", schemaVersion: 1 };
const receipt: ContextReceipt = { receiptId: "receipt-1", sessionId: "session-1", repositoryIdentity: "repo-1", workspaceIdentity: "workspace-1", subject: { kind: "file", path: "src/index.ts" }, subjectIdentity: "subject-1", projectionIdentity: "projection-1", contextGeneration: "generation-1", deliveryMode: "full", deliveredContentIdentity: contentIdentity("hello"), snapshotId: "snapshot-1", reliability: { mayBeIncomplete: false }, deliveredAt: "2026-09-13T00:00:00.000Z", state: "active", schemaVersion: 1 };
const snapshot: DeliveredSnapshot = { snapshotId: "snapshot-1", receiptId: "receipt-1", subjectIdentity: "subject-1", projectionIdentity: "projection-1", content: "hello", contentIdentity: contentIdentity("hello"), createdAt: "2026-09-13T00:00:00.000Z", schemaVersion: 1 };
const lifecycle: TaskContextLifecycle = { taskContextId: "00000000-0000-4000-8000-000000000001", repositoryIdentity: "repo-1", workspaceIdentity: "workspace-1", sessionId: "session-1", contextGeneration: "generation-1", task: "find it", anchors: [{ kind: "file", path: "src/index.ts" }], taskIdentity: "task-intent-v1:identity", defaultBudget: { maxItems: 20, maxEstimatedTokens: 4000 }, ttlSeconds: 86400, revision: 0, state: "active", createdAt: session.createdAt, lastSeenAt: session.lastSeenAt, schemaVersion: 2 };

test("lifecycle start persists revision one and refresh CAS conflict does not publish", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-store-"));
  try {
    const store = new ContextStore(path.join(root, "context.db"));
    const started = store.createAndCommitStart({ lifecycle, session, prepared: [{ session, receipt, snapshot }] });
    assert.equal(started.revision, 1);
    assert.equal(store.loadLifecycle(lifecycle.taskContextId)?.revision, 1);
    assert.throws(() => store.commitRefresh({ taskContextId: lifecycle.taskContextId, expectedRevision: 0, now: "2026-09-13T00:01:00.000Z", repositoryIdentity: "repo-1", workspaceIdentity: "workspace-1", prepared: [{ session, receipt: { ...receipt, receiptId: "receipt-2", snapshotId: "snapshot-2" }, snapshot: { ...snapshot, receiptId: "receipt-2", snapshotId: "snapshot-2" } }], latestTaskIdentity: "task-2", latestPlanIdentity: "plan-2" }), (error: unknown) => error instanceof TaskContextLifecycleDomainError && error.operationError.code === "lifecycle_conflict");
    assert.equal(store.loadLifecycle(lifecycle.taskContextId)?.revision, 1);
    assert.equal((store as unknown as { database: { prepare(sql: string): { get(): { count: number } } } }).database.prepare("SELECT count(*) AS count FROM context_receipts").get().count, 1);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
