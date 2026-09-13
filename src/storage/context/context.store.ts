import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { validateContextSession, validateContextSubject } from "../../core/context/context-identity.js";
import { contentIdentity } from "../../core/context/context-snapshot.js";
import type { ContextReceipt, ContextSession, DeliveredSnapshot, PreparedContextAwareRead } from "../../core/context/context.types.js";
import type { TaskContextLifecycle } from "../../core/context/task-context-lifecycle.types.js";
import { TaskContextLifecycleDomainError } from "../../core/context/task-context-lifecycle.types.js";
import { CONTEXT_SCHEMA_VERSION, initializeContextSchema, UnsupportedContextSchemaError } from "./context.schema.js";

export { CONTEXT_SCHEMA_VERSION };
export const DEFAULT_CONTEXT_DB_PATH = ".codeatlas/context.db";

export class ContextStoreOpenError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ContextStoreOpenError";
  }
}

type StoredTaskContextLifecycle = Omit<TaskContextLifecycle, "taskIdentity"> & { taskIntentIdentity: string; taskIdentity: string };

function json(value: unknown): string {
  return JSON.stringify(value, Object.keys(value as object).sort()) ?? "null";
}

function ensureParent(filePath: string): void {
  mkdirSync(path.dirname(path.resolve(filePath)), { recursive: true });
}

export class ContextStore {
  readonly schemaVersion = CONTEXT_SCHEMA_VERSION;
  private readonly database: DatabaseSync;

  constructor(databasePath = DEFAULT_CONTEXT_DB_PATH) {
    let opened: DatabaseSync | undefined;
    try {
      ensureParent(databasePath);
      opened = new DatabaseSync(databasePath);
      this.database = opened;
      initializeContextSchema(this.database);
    } catch (error) {
      try { opened?.close(); } catch { /* opening may have failed */ }
      if (error instanceof UnsupportedContextSchemaError) throw error;
      throw new ContextStoreOpenError(`Context database is unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }

  saveSession(value: ContextSession): void {
    const session = validateContextSession(value);
    this.database.prepare(`INSERT INTO context_sessions(session_id, repository_identity, workspace_identity, consumer_json, created_at, last_seen_at, context_generation, schema_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET repository_identity=excluded.repository_identity, workspace_identity=excluded.workspace_identity, consumer_json=excluded.consumer_json, last_seen_at=excluded.last_seen_at, context_generation=excluded.context_generation, schema_version=excluded.schema_version`).run(
      session.sessionId, session.repositoryIdentity, session.workspaceIdentity, session.consumer ? json(session.consumer) : null,
      session.createdAt, session.lastSeenAt, session.contextGeneration, session.schemaVersion,
    );
  }

  getSession(sessionId: string): ContextSession | undefined {
    const row = this.database.prepare("SELECT * FROM context_sessions WHERE session_id = ?").get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      sessionId: row.session_id as string, repositoryIdentity: row.repository_identity as string, workspaceIdentity: row.workspace_identity as string,
      ...(row.consumer_json ? { consumer: JSON.parse(row.consumer_json as string) } : {}), createdAt: row.created_at as string,
      lastSeenAt: row.last_seen_at as string, contextGeneration: row.context_generation as string, schemaVersion: row.schema_version as number,
    };
  }

  publish(sessionValue: ContextSession, receipt: ContextReceipt, snapshot: DeliveredSnapshot): void {
    this.publishPrepared({ session: sessionValue, receipt, snapshot });
  }

  publishPrepared(prepared: Pick<PreparedContextAwareRead, "session" | "receipt" | "snapshot">): void {
    const { session: sessionValue, receipt, snapshot } = prepared;
    const session = validateContextSession(sessionValue);
    validateContextSubject(receipt.subject);
    if (receipt.sessionId !== session.sessionId || receipt.snapshotId !== snapshot.snapshotId || snapshot.receiptId !== receipt.receiptId) throw new TypeError("receipt and snapshot linkage is invalid");
    if (receipt.repositoryIdentity !== session.repositoryIdentity || receipt.workspaceIdentity !== session.workspaceIdentity) throw new TypeError("receipt and session identity is invalid");
    if (snapshot.subjectIdentity !== receipt.subjectIdentity || snapshot.projectionIdentity !== receipt.projectionIdentity || snapshot.contentIdentity !== receipt.deliveredContentIdentity || snapshot.contentIdentity !== contentIdentity(snapshot.content)) throw new TypeError("receipt and snapshot identity is invalid");
    this.database.exec("BEGIN");
    try {
      this.writeSession(session);
      this.database.prepare("INSERT INTO context_snapshots(snapshot_id, receipt_id, subject_identity, projection_identity, content, content_identity, created_at, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(snapshot.snapshotId, snapshot.receiptId, snapshot.subjectIdentity, snapshot.projectionIdentity, snapshot.content, snapshot.contentIdentity, snapshot.createdAt, snapshot.schemaVersion);
      this.database.prepare("INSERT INTO context_receipts(receipt_id, session_id, repository_identity, workspace_identity, subject_json, subject_identity, projection_identity, context_generation, delivery_mode, delivered_content_identity, snapshot_id, reliability_json, delivered_at, expires_at, prior_receipt_id, state, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(receipt.receiptId, receipt.sessionId, receipt.repositoryIdentity, receipt.workspaceIdentity, json(receipt.subject), receipt.subjectIdentity, receipt.projectionIdentity, receipt.contextGeneration, receipt.deliveryMode, receipt.deliveredContentIdentity, receipt.snapshotId, json(receipt.reliability), receipt.deliveredAt, receipt.expiresAt ?? null, receipt.priorReceiptId ?? null, receipt.state, receipt.schemaVersion);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private writeSession(session: ContextSession): void {
    this.database.prepare(`INSERT INTO context_sessions(session_id, repository_identity, workspace_identity, consumer_json, created_at, last_seen_at, context_generation, schema_version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(session_id) DO UPDATE SET repository_identity=excluded.repository_identity, workspace_identity=excluded.workspace_identity, consumer_json=excluded.consumer_json, last_seen_at=excluded.last_seen_at, context_generation=excluded.context_generation, schema_version=excluded.schema_version`).run(
      session.sessionId, session.repositoryIdentity, session.workspaceIdentity, session.consumer ? json(session.consumer) : null,
      session.createdAt, session.lastSeenAt, session.contextGeneration, session.schemaVersion,
    );
  }

  private validatePublication(sessionValue: ContextSession, receipt: ContextReceipt, snapshot: DeliveredSnapshot): ContextSession {
    const session = validateContextSession(sessionValue);
    validateContextSubject(receipt.subject);
    if (receipt.sessionId !== session.sessionId || receipt.snapshotId !== snapshot.snapshotId || snapshot.receiptId !== receipt.receiptId) throw new TypeError("receipt and snapshot linkage is invalid");
    if (receipt.repositoryIdentity !== session.repositoryIdentity || receipt.workspaceIdentity !== session.workspaceIdentity) throw new TypeError("receipt and session identity is invalid");
    if (snapshot.subjectIdentity !== receipt.subjectIdentity || snapshot.projectionIdentity !== receipt.projectionIdentity || snapshot.contentIdentity !== receipt.deliveredContentIdentity || snapshot.contentIdentity !== contentIdentity(snapshot.content)) throw new TypeError("receipt and snapshot identity is invalid");
    return session;
  }

  private writePublication(session: ContextSession, receipt: ContextReceipt, snapshot: DeliveredSnapshot): void {
    this.validatePublication(session, receipt, snapshot);
    this.writeSession(session);
    this.database.prepare("INSERT INTO context_snapshots(snapshot_id, receipt_id, subject_identity, projection_identity, content, content_identity, created_at, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(snapshot.snapshotId, snapshot.receiptId, snapshot.subjectIdentity, snapshot.projectionIdentity, snapshot.content, snapshot.contentIdentity, snapshot.createdAt, snapshot.schemaVersion);
    this.database.prepare("INSERT INTO context_receipts(receipt_id, session_id, repository_identity, workspace_identity, subject_json, subject_identity, projection_identity, context_generation, delivery_mode, delivered_content_identity, snapshot_id, reliability_json, delivered_at, expires_at, prior_receipt_id, state, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(receipt.receiptId, receipt.sessionId, receipt.repositoryIdentity, receipt.workspaceIdentity, json(receipt.subject), receipt.subjectIdentity, receipt.projectionIdentity, receipt.contextGeneration, receipt.deliveryMode, receipt.deliveredContentIdentity, receipt.snapshotId, json(receipt.reliability), receipt.deliveredAt, receipt.expiresAt ?? null, receipt.priorReceiptId ?? null, receipt.state, receipt.schemaVersion);
  }

  createAndCommitStart(input: { lifecycle: StoredTaskContextLifecycle; session: ContextSession; prepared: Array<{ session: ContextSession; receipt: ContextReceipt; snapshot: DeliveredSnapshot }> }): StoredTaskContextLifecycle {
    this.validateStart(input.lifecycle, input.session, input.prepared);
    this.database.exec("BEGIN");
    try {
      this.writeSession(input.session);
      this.database.prepare("INSERT INTO task_context_lifecycles (task_context_id, repository_identity, workspace_identity, session_id, context_generation, task, anchors_json, task_intent_identity, latest_task_identity, max_items, max_estimated_tokens, ttl_seconds, latest_plan_identity, revision, state, created_at, last_seen_at, expires_at, closed_at, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(input.lifecycle.taskContextId, input.lifecycle.repositoryIdentity, input.lifecycle.workspaceIdentity, input.lifecycle.sessionId, input.lifecycle.contextGeneration, input.lifecycle.task, json(input.lifecycle.anchors), input.lifecycle.taskIntentIdentity, input.lifecycle.latestTaskIdentity ?? input.lifecycle.taskIdentity, input.lifecycle.defaultBudget.maxItems, input.lifecycle.defaultBudget.maxEstimatedTokens, input.lifecycle.ttlSeconds, input.lifecycle.latestPlanIdentity ?? null, 0, input.lifecycle.state, input.lifecycle.createdAt, input.lifecycle.lastSeenAt, input.lifecycle.expiresAt ?? null, input.lifecycle.closedAt ?? null, input.lifecycle.schemaVersion);
      for (const prepared of input.prepared) this.writePublication(prepared.session, prepared.receipt, prepared.snapshot);
      const revisionUpdate = this.database.prepare("UPDATE task_context_lifecycles SET revision = 1 WHERE task_context_id = ? AND revision = 0").run(input.lifecycle.taskContextId);
      if (revisionUpdate.changes !== 1) throw new Error("lifecycle start revision update affected an unexpected number of rows");
      const result = this.readLifecycle(input.lifecycle.taskContextId);
      this.database.exec("COMMIT");
      if (!result) throw new Error("lifecycle disappeared during commit");
      return result;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  loadLifecycle(taskContextId: string): StoredTaskContextLifecycle | undefined { return this.readLifecycle(taskContextId); }

  commitRefresh(input: { taskContextId: string; expectedRevision: number; now: string; repositoryIdentity: string; workspaceIdentity: string; prepared: Array<{ session: ContextSession; receipt: ContextReceipt; snapshot: DeliveredSnapshot }>; latestTaskIdentity: string; latestPlanIdentity: string }): StoredTaskContextLifecycle {
    this.database.exec("BEGIN");
    try {
      const current = this.readLifecycle(input.taskContextId);
      if (!current) throw this.lifecycleError("refresh", "context_not_found", input.taskContextId);
      if (current.repositoryIdentity !== input.repositoryIdentity || current.workspaceIdentity !== input.workspaceIdentity) throw this.lifecycleError("refresh", "workspace_mismatch", input.taskContextId);
      if (current.revision !== input.expectedRevision) throw this.lifecycleError("refresh", "lifecycle_conflict", input.taskContextId);
      if (current.state === "closed") throw this.lifecycleError("refresh", "context_closed", input.taskContextId);
      if (current.state === "expired") throw this.lifecycleError("refresh", "context_expired", input.taskContextId);
      this.validatePreparedForLifecycle(current, input.prepared);
      if (current.expiresAt && Date.parse(input.now) >= Date.parse(current.expiresAt)) {
        const expired = this.database.prepare("UPDATE task_context_lifecycles SET state = 'expired', last_seen_at = ?, revision = revision + 1 WHERE task_context_id = ? AND revision = ? AND state = 'active'").run(input.now, input.taskContextId, input.expectedRevision);
        if (expired.changes !== 1) throw this.lifecycleError("refresh", "lifecycle_conflict", input.taskContextId);
        const result = this.readLifecycle(input.taskContextId);
        this.database.exec("COMMIT");
        throw this.lifecycleError("refresh", "context_expired", input.taskContextId);
      }
      for (const prepared of input.prepared) this.writePublication(prepared.session, prepared.receipt, prepared.snapshot);
      const expiresAt = new Date(Date.parse(input.now) + current.ttlSeconds * 1000).toISOString();
      const update = this.database.prepare("UPDATE task_context_lifecycles SET last_seen_at = ?, expires_at = ?, latest_task_identity = ?, latest_plan_identity = ?, revision = revision + 1 WHERE task_context_id = ? AND revision = ? AND state = 'active'").run(input.now, expiresAt, input.latestTaskIdentity, input.latestPlanIdentity, input.taskContextId, input.expectedRevision);
      if (update.changes !== 1) throw this.lifecycleError("refresh", "lifecycle_conflict", input.taskContextId);
      const result = this.readLifecycle(input.taskContextId);
      this.database.exec("COMMIT");
      if (!result) throw new Error("lifecycle disappeared during commit");
      return result;
    } catch (error) { try { this.database.exec("ROLLBACK"); } catch { /* transaction already committed for expiry */ } throw error; }
  }

  closeLifecycle(input: { taskContextId: string; expectedRevision: number; now: string; repositoryIdentity: string; workspaceIdentity: string }): StoredTaskContextLifecycle {
    return this.commitLifecycleChange(input, "close", () => { this.database.prepare("UPDATE task_context_lifecycles SET state = CASE WHEN state = 'active' THEN 'closed' ELSE state END, closed_at = CASE WHEN state = 'active' THEN ? ELSE closed_at END, last_seen_at = CASE WHEN state = 'active' THEN ? ELSE last_seen_at END, revision = CASE WHEN state = 'active' THEN revision + 1 ELSE revision END WHERE task_context_id = ? AND revision = ?").run(input.now, input.now, input.taskContextId, input.expectedRevision); });
  }

  expireLifecycle(input: { taskContextId: string; expectedRevision: number; now: string; repositoryIdentity: string; workspaceIdentity: string }): StoredTaskContextLifecycle {
    return this.commitLifecycleChange(input, "expire", () => { this.database.prepare("UPDATE task_context_lifecycles SET state = 'expired', last_seen_at = ?, revision = revision + 1 WHERE task_context_id = ? AND revision = ? AND state = 'active'").run(input.now, input.taskContextId, input.expectedRevision); });
  }

  private commitLifecycleChange(input: { taskContextId: string; expectedRevision: number; now: string; repositoryIdentity: string; workspaceIdentity: string }, operation: "refresh" | "close" | "expire", write: () => void): StoredTaskContextLifecycle {
    this.database.exec("BEGIN");
    try {
      const current = this.readLifecycle(input.taskContextId);
      if (!current) throw this.lifecycleError(operation, "context_not_found", input.taskContextId);
      if (current.repositoryIdentity !== input.repositoryIdentity || current.workspaceIdentity !== input.workspaceIdentity) throw this.lifecycleError(operation, "workspace_mismatch", input.taskContextId);
      if (current.revision !== input.expectedRevision) throw this.lifecycleError(operation, "lifecycle_conflict", input.taskContextId);
      if (operation === "close" && (current.state === "closed" || current.state === "expired")) { this.database.exec("COMMIT"); return current; }
      if (current.state === "closed") throw this.lifecycleError(operation, "context_closed", input.taskContextId);
      if (current.state === "expired") throw this.lifecycleError(operation, "context_expired", input.taskContextId);
      if (operation === "refresh") this.validatePreparedForLifecycle(current, (input as unknown as { prepared: Array<{ session: ContextSession; receipt: ContextReceipt; snapshot: DeliveredSnapshot }> }).prepared);
      write();
      const result = this.readLifecycle(input.taskContextId);
      this.database.exec("COMMIT");
      if (!result) throw new Error("lifecycle disappeared during commit");
      return result;
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  private lifecycleError(operation: "refresh" | "close" | "expire", code: "context_not_found" | "workspace_mismatch" | "context_closed" | "context_expired" | "lifecycle_conflict", taskContextId: string): TaskContextLifecycleDomainError {
    return new TaskContextLifecycleDomainError({ code, operation, taskContextId, message: `${code}: ${taskContextId}` });
  }

  private readLifecycle(taskContextId: string): StoredTaskContextLifecycle | undefined {
    const row = this.database.prepare("SELECT * FROM task_context_lifecycles WHERE task_context_id = ?").get(taskContextId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { taskContextId: row.task_context_id as string, repositoryIdentity: row.repository_identity as string, workspaceIdentity: row.workspace_identity as string, sessionId: row.session_id as string, contextGeneration: row.context_generation as string, task: row.task as string, anchors: JSON.parse(row.anchors_json as string), taskIntentIdentity: row.task_intent_identity as string, taskIdentity: row.latest_task_identity as string, ...(row.latest_task_identity ? { latestTaskIdentity: row.latest_task_identity as string } : {}), defaultBudget: { maxItems: row.max_items as number, maxEstimatedTokens: row.max_estimated_tokens as number }, ttlSeconds: row.ttl_seconds as number, ...(row.latest_plan_identity ? { latestPlanIdentity: row.latest_plan_identity as string } : {}), revision: row.revision as number, state: row.state as TaskContextLifecycle["state"], createdAt: row.created_at as string, lastSeenAt: row.last_seen_at as string, ...(row.expires_at ? { expiresAt: row.expires_at as string } : {}), ...(row.closed_at ? { closedAt: row.closed_at as string } : {}), schemaVersion: row.schema_version as number };
  }

  private validateStart(lifecycle: StoredTaskContextLifecycle, sessionValue: ContextSession, prepared: Array<{ session: ContextSession; receipt: ContextReceipt; snapshot: DeliveredSnapshot }>): void {
    const session = validateContextSession(sessionValue);
    if (lifecycle.schemaVersion !== CONTEXT_SCHEMA_VERSION || lifecycle.state !== "active" || lifecycle.revision !== 0) throw new TypeError("lifecycle start must be active at revision 0 with the current schema");
    if (!lifecycle.taskIntentIdentity || lifecycle.sessionId !== session.sessionId || lifecycle.contextGeneration !== session.contextGeneration || lifecycle.repositoryIdentity !== session.repositoryIdentity || lifecycle.workspaceIdentity !== session.workspaceIdentity) throw new TypeError("lifecycle and session identity is invalid");
    for (const item of prepared) {
      if (item.session.sessionId !== lifecycle.sessionId || item.session.contextGeneration !== lifecycle.contextGeneration || item.session.repositoryIdentity !== lifecycle.repositoryIdentity || item.session.workspaceIdentity !== lifecycle.workspaceIdentity) throw new TypeError("publication session identity is invalid");
      this.validatePublication(item.session, item.receipt, item.snapshot);
      if (item.receipt.contextGeneration !== lifecycle.contextGeneration) throw new TypeError("publication context generation is invalid");
    }
  }

  private validatePreparedForLifecycle(lifecycle: StoredTaskContextLifecycle, prepared: Array<{ session: ContextSession; receipt: ContextReceipt; snapshot: DeliveredSnapshot }>): void {
    for (const item of prepared) {
      if (item.session.sessionId !== lifecycle.sessionId || item.session.contextGeneration !== lifecycle.contextGeneration || item.session.repositoryIdentity !== lifecycle.repositoryIdentity || item.session.workspaceIdentity !== lifecycle.workspaceIdentity) throw new TypeError("publication session identity is invalid");
      this.validatePublication(item.session, item.receipt, item.snapshot);
      if (item.receipt.contextGeneration !== lifecycle.contextGeneration) throw new TypeError("publication context generation is invalid");
    }
  }

  getReceipt(receiptId: string): ContextReceipt | undefined {
    const row = this.database.prepare("SELECT * FROM context_receipts WHERE receipt_id = ?").get(receiptId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { receiptId: row.receipt_id as string, sessionId: row.session_id as string, repositoryIdentity: row.repository_identity as string, workspaceIdentity: row.workspace_identity as string, subject: JSON.parse(row.subject_json as string), subjectIdentity: row.subject_identity as string, projectionIdentity: row.projection_identity as string, contextGeneration: row.context_generation as string, deliveryMode: row.delivery_mode as ContextReceipt["deliveryMode"], deliveredContentIdentity: row.delivered_content_identity as string, snapshotId: row.snapshot_id as string, reliability: JSON.parse(row.reliability_json as string), deliveredAt: row.delivered_at as string, ...(row.expires_at ? { expiresAt: row.expires_at as string } : {}), ...(row.prior_receipt_id ? { priorReceiptId: row.prior_receipt_id as string } : {}), state: row.state as ContextReceipt["state"], schemaVersion: row.schema_version as number };
  }

  findLatestReceipt(sessionId: string, subjectIdentity: string, projectionIdentity: string): ContextReceipt | undefined {
    const row = this.database.prepare("SELECT receipt_id FROM context_receipts WHERE session_id = ? AND subject_identity = ? AND projection_identity = ? ORDER BY delivered_at DESC, receipt_id DESC LIMIT 1").get(sessionId, subjectIdentity, projectionIdentity) as { receipt_id?: string } | undefined;
    return row?.receipt_id ? this.getReceipt(row.receipt_id) : undefined;
  }

  getSnapshot(snapshotId: string): DeliveredSnapshot | undefined {
    const row = this.database.prepare("SELECT * FROM context_snapshots WHERE snapshot_id = ?").get(snapshotId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { snapshotId: row.snapshot_id as string, receiptId: row.receipt_id as string, subjectIdentity: row.subject_identity as string, projectionIdentity: row.projection_identity as string, content: row.content as string, contentIdentity: row.content_identity as string, createdAt: row.created_at as string, schemaVersion: row.schema_version as number };
  }

  close(): void { this.database.close(); }
}
