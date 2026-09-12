import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { validateContextSession, validateContextSubject } from "../../core/context/context-identity.js";
import type { ContextReceipt, ContextSession, DeliveredSnapshot } from "../../core/context/context.types.js";
import { CONTEXT_SCHEMA_VERSION, initializeContextSchema } from "./context.schema.js";

export { CONTEXT_SCHEMA_VERSION };
export const DEFAULT_CONTEXT_DB_PATH = ".codeatlas/context.db";

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
    ensureParent(databasePath);
    this.database = new DatabaseSync(databasePath);
    try { initializeContextSchema(this.database); } catch (error) { this.database.close(); throw new Error(`Context database is unavailable: ${error instanceof Error ? error.message : String(error)}`, { cause: error }); }
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
    const session = validateContextSession(sessionValue);
    validateContextSubject(receipt.subject);
    if (receipt.sessionId !== session.sessionId || receipt.snapshotId !== snapshot.snapshotId || snapshot.receiptId !== receipt.receiptId) throw new TypeError("receipt and snapshot linkage is invalid");
    if (snapshot.subjectIdentity !== receipt.subjectIdentity || snapshot.projectionIdentity !== receipt.projectionIdentity || snapshot.contentIdentity !== receipt.deliveredContentIdentity) throw new TypeError("receipt and snapshot identity is invalid");
    this.saveSession(session);
    this.database.exec("BEGIN");
    try {
      this.database.prepare("INSERT INTO context_snapshots(snapshot_id, receipt_id, subject_identity, projection_identity, content, content_identity, created_at, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run(snapshot.snapshotId, snapshot.receiptId, snapshot.subjectIdentity, snapshot.projectionIdentity, snapshot.content, snapshot.contentIdentity, snapshot.createdAt, snapshot.schemaVersion);
      this.database.prepare("INSERT INTO context_receipts(receipt_id, session_id, repository_identity, workspace_identity, subject_json, subject_identity, projection_identity, context_generation, delivery_mode, delivered_content_identity, snapshot_id, reliability_json, delivered_at, expires_at, prior_receipt_id, state, schema_version) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(receipt.receiptId, receipt.sessionId, receipt.repositoryIdentity, receipt.workspaceIdentity, json(receipt.subject), receipt.subjectIdentity, receipt.projectionIdentity, receipt.contextGeneration, receipt.deliveryMode, receipt.deliveredContentIdentity, receipt.snapshotId, json(receipt.reliability), receipt.deliveredAt, receipt.expiresAt ?? null, receipt.priorReceiptId ?? null, receipt.state, receipt.schemaVersion);
      this.database.exec("COMMIT");
    } catch (error) { this.database.exec("ROLLBACK"); throw error; }
  }

  getReceipt(receiptId: string): ContextReceipt | undefined {
    const row = this.database.prepare("SELECT * FROM context_receipts WHERE receipt_id = ?").get(receiptId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { receiptId: row.receipt_id as string, sessionId: row.session_id as string, repositoryIdentity: row.repository_identity as string, workspaceIdentity: row.workspace_identity as string, subject: JSON.parse(row.subject_json as string), subjectIdentity: row.subject_identity as string, projectionIdentity: row.projection_identity as string, contextGeneration: row.context_generation as string, deliveryMode: row.delivery_mode as ContextReceipt["deliveryMode"], deliveredContentIdentity: row.delivered_content_identity as string, snapshotId: row.snapshot_id as string, reliability: JSON.parse(row.reliability_json as string), deliveredAt: row.delivered_at as string, ...(row.expires_at ? { expiresAt: row.expires_at as string } : {}), ...(row.prior_receipt_id ? { priorReceiptId: row.prior_receipt_id as string } : {}), state: row.state as ContextReceipt["state"], schemaVersion: row.schema_version as number };
  }

  getSnapshot(snapshotId: string): DeliveredSnapshot | undefined {
    const row = this.database.prepare("SELECT * FROM context_snapshots WHERE snapshot_id = ?").get(snapshotId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return { snapshotId: row.snapshot_id as string, receiptId: row.receipt_id as string, subjectIdentity: row.subject_identity as string, projectionIdentity: row.projection_identity as string, content: row.content as string, contentIdentity: row.content_identity as string, createdAt: row.created_at as string, schemaVersion: row.schema_version as number };
  }

  close(): void { this.database.close(); }
}
