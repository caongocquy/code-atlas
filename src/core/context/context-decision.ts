import type { ContextReceipt, ContextSession, DeliveredSnapshot, DeliveryMode } from "./context.types.js";

export type ContextDecisionInput = {
  session: ContextSession;
  receipt?: ContextReceipt;
  snapshot?: DeliveredSnapshot;
  hasPriorReceipt?: boolean;
  currentContentIdentity: string;
  subjectIdentity: string;
  projectionIdentity: string;
  now: string;
  exactDeltaAvailable: boolean;
  reconstructionValid: boolean;
  currentReadable: boolean;
};

export type ContextDecision = { mode: DeliveryMode; reason?: string };

export function decideContextMode(input: ContextDecisionInput): ContextDecision {
  const hasPriorReceipt = input.hasPriorReceipt ?? input.receipt !== undefined;
  if (!hasPriorReceipt) return { mode: "full", reason: "first_read" };
  if (!input.currentReadable) return { mode: "rehydrate", reason: "current_read_failed" };
  const receipt = input.receipt;
  if (!receipt) return { mode: "rehydrate", reason: "missing_receipt" };
  if (receipt.state !== "active") return { mode: "rehydrate", reason: "receipt_not_active" };
  if (receipt.expiresAt && Date.parse(receipt.expiresAt) <= Date.parse(input.now)) return { mode: "rehydrate", reason: "receipt_expired" };
  if (receipt.sessionId !== input.session.sessionId || receipt.repositoryIdentity !== input.session.repositoryIdentity || receipt.workspaceIdentity !== input.session.workspaceIdentity || receipt.contextGeneration !== input.session.contextGeneration) return { mode: "rehydrate", reason: "identity_mismatch" };
  if (receipt.subjectIdentity !== input.subjectIdentity || receipt.projectionIdentity !== input.projectionIdentity) return { mode: "rehydrate", reason: "selector_mismatch" };
  if (receipt.deliveredContentIdentity === input.currentContentIdentity) return { mode: "unchanged" };
  if (!input.snapshot) return { mode: "rehydrate", reason: "missing_snapshot" };
  if (input.snapshot.receiptId !== receipt.receiptId || input.snapshot.contentIdentity !== receipt.deliveredContentIdentity) return { mode: "rehydrate", reason: "snapshot_mismatch" };
  if (!input.exactDeltaAvailable) return { mode: "rehydrate", reason: "delta_unavailable" };
  if (!input.reconstructionValid) return { mode: "rehydrate", reason: "reconstruction_failed" };
  return { mode: "delta" };
}
