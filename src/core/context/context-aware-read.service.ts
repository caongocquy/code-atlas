import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { getRepositoryStatusReadOnly } from "../repository/repository-status.service.js";
import { canonicalRepositoryPath } from "../repository/repository-identity.js";
import { loadIndexedGraphReadOnly } from "../graph/indexed-graph.service.js";
import { canonicalProjectionIdentity } from "./context-identity.js";
import { getWorkspaceIdentity } from "./context-identity.js";
import { decideContextMode } from "./context-decision.js";
import { applyDelta, createExactDelta } from "./context-delta.js";
import { contentIdentity, createDeliveredSnapshot } from "./context-snapshot.js";
import type { ContextAwareReadResult, ContextReceipt, ContextSession, ContextSubject } from "./context.types.js";
import { ContextStore } from "../../storage/context/context.store.js";

export type ContextAwareReadRequest = {
  sessionId: string;
  contextGeneration: string;
  subject: ContextSubject;
  projection: string;
  ttlSeconds?: number;
};

export type ContextMetrics = {
  requestedBytes: number;
  returnedBytes: number;
  fullReads: number;
  unchangedReads: number;
  deltaReads: number;
  rehydrates: number;
  savedBytes: number;
};

const metrics: ContextMetrics = { requestedBytes: 0, returnedBytes: 0, fullReads: 0, unchangedReads: 0, deltaReads: 0, rehydrates: 0, savedBytes: 0 };

export function resetContextMetrics(): void { Object.assign(metrics, { requestedBytes: 0, returnedBytes: 0, fullReads: 0, unchangedReads: 0, deltaReads: 0, rehydrates: 0, savedBytes: 0 }); }
export function getContextMetrics(): ContextMetrics { return { ...metrics }; }

function recordMetrics(mode: ContextAwareReadResult["mode"], requestedBytes: number, returnedBytes: number): void {
  metrics.requestedBytes += requestedBytes;
  metrics.returnedBytes += returnedBytes;
  metrics.savedBytes += Math.max(0, requestedBytes - returnedBytes);
  if (mode === "full") metrics.fullReads += 1;
  if (mode === "unchanged") metrics.unchangedReads += 1;
  if (mode === "delta") metrics.deltaReads += 1;
  if (mode === "rehydrate") metrics.rehydrates += 1;
}

async function readSubject(root: string, subject: ContextSubject): Promise<string> {
  const source = await fs.readFile(path.join(root, subject.path), "utf8");
  if (subject.kind === "file") return source;
  const graph = await loadIndexedGraphReadOnly(root);
  const nodes = graph.graph.nodes.filter((node) => node.id === subject.symbolId && node.file === subject.path && node.startLine !== undefined && node.endLine !== undefined);
  if (nodes.length !== 1) throw new Error("Symbol selector is not uniquely indexed");
  const lines = source.split(/\r?\n/);
  return lines.slice(nodes[0]!.startLine! - 1, nodes[0]!.endLine!).join("\n");
}

function reliability(status: Awaited<ReturnType<typeof getRepositoryStatusReadOnly>> | undefined): unknown {
  return {
    source: "current-codeatlas-state",
    mayBeIncomplete: status ? status.graph.status === "stale" || status.graph.resolutionCoverage.mayBeIncomplete : true,
    graph: status?.graph.status ?? "unavailable",
  };
}

function sessionFor(workspace: ReturnType<typeof getWorkspaceIdentity>, request: ContextAwareReadRequest, now: string): ContextSession {
  return { sessionId: request.sessionId, repositoryIdentity: workspace.repositoryIdentity, workspaceIdentity: workspace.workspaceIdentity, createdAt: now, lastSeenAt: now, contextGeneration: request.contextGeneration, schemaVersion: 1 };
}

export async function readContextAware(repoPath: string, request: ContextAwareReadRequest): Promise<ContextAwareReadResult> {
  const root = canonicalRepositoryPath(path.resolve(repoPath));
  const workspace = getWorkspaceIdentity(root);
  const now = new Date().toISOString();
  const session = sessionFor(workspace, request, now);
  const subjectIdentity = canonicalProjectionIdentity("subject", { repositoryIdentity: workspace.repositoryIdentity, workspaceIdentity: workspace.workspaceIdentity, subject: request.subject });
  const projectionIdentity = canonicalProjectionIdentity(request.projection, { schemaVersion: 1 });
  let status;
  try { status = await getRepositoryStatusReadOnly(root); } catch { status = undefined; }
  let content: string;
  try { content = await readSubject(root, request.subject); } catch (error) {
    throw new Error(`Context-aware source read failed: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const currentIdentity = contentIdentity(content);
  let store: ContextStore;
  try { store = new ContextStore(path.join(root, ".codeatlas", "context.db")); } catch (error) {
    const receipt: ContextReceipt = { receiptId: randomUUID(), sessionId: session.sessionId, repositoryIdentity: workspace.repositoryIdentity, workspaceIdentity: workspace.workspaceIdentity, subject: request.subject, subjectIdentity, projectionIdentity, contextGeneration: session.contextGeneration, deliveryMode: "rehydrate", deliveredContentIdentity: currentIdentity, snapshotId: randomUUID(), reliability: reliability(status), deliveredAt: now, state: "invalid", schemaVersion: 1 };
    const result = { mode: "rehydrate" as const, receipt, current: { contentIdentity: currentIdentity, reliability: receipt.reliability }, content, reason: `context_database_unavailable: ${error instanceof Error ? error.message : String(error)}` };
    recordMetrics(result.mode, Buffer.byteLength(content), Buffer.byteLength(content));
    return result;
  }
  try {
    const previous = store.findLatestReceipt(request.sessionId, subjectIdentity, projectionIdentity);
    const previousSnapshot = previous ? store.getSnapshot(previous.snapshotId) : undefined;
    const delta = previousSnapshot && previous!.deliveredContentIdentity !== currentIdentity ? createExactDelta(previousSnapshot.content, content) : undefined;
    const decision = decideContextMode({ session, receipt: previous, snapshot: previousSnapshot, hasPriorReceipt: previous !== undefined, currentContentIdentity: currentIdentity, subjectIdentity, projectionIdentity, now, exactDeltaAvailable: delta !== undefined, reconstructionValid: delta ? applyDelta(previousSnapshot!.content, delta) === content && contentIdentity(applyDelta(previousSnapshot!.content, delta)) === currentIdentity : false, currentReadable: true });
    const receiptId = randomUUID();
    const snapshotId = randomUUID();
    const receipt: ContextReceipt = { receiptId, sessionId: session.sessionId, repositoryIdentity: workspace.repositoryIdentity, workspaceIdentity: workspace.workspaceIdentity, subject: request.subject, subjectIdentity, projectionIdentity, contextGeneration: session.contextGeneration, deliveryMode: decision.mode, deliveredContentIdentity: currentIdentity, snapshotId, reliability: reliability(status), deliveredAt: now, ...(request.ttlSeconds !== undefined ? { expiresAt: new Date(Date.parse(now) + request.ttlSeconds * 1000).toISOString() } : {}), ...(previous ? { priorReceiptId: previous.receiptId } : {}), state: "active", schemaVersion: 1 };
    const snapshot = createDeliveredSnapshot({ snapshotId, receiptId, subjectIdentity, projectionIdentity }, content);
    store.publish(session, receipt, snapshot);
    const result = { mode: decision.mode, receipt, current: { contentIdentity: currentIdentity, reliability: receipt.reliability }, ...(decision.mode === "full" || decision.mode === "rehydrate" ? { content } : {}), ...(decision.mode === "delta" ? { delta } : {}), ...(decision.reason ? { reason: decision.reason } : {}) } as ContextAwareReadResult;
    recordMetrics(result.mode, Buffer.byteLength(content), Buffer.byteLength(result.content ?? (result.delta ? JSON.stringify(result.delta) : "")));
    return result;
  } finally { store.close(); }
}
