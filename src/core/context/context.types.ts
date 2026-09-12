export type ContextSubject =
  | { kind: "file"; path: string }
  | { kind: "symbol"; path: string; symbolId: string; selectorVersion: string };

export type ContextSession = {
  sessionId: string;
  repositoryIdentity: string;
  workspaceIdentity: string;
  consumer?: { kind: string; id: string; version?: string };
  createdAt: string;
  lastSeenAt: string;
  contextGeneration: string;
  schemaVersion: number;
};

export type DeliveryMode = "full" | "unchanged" | "delta" | "rehydrate";

export type ContextReceipt = {
  receiptId: string;
  sessionId: string;
  repositoryIdentity: string;
  workspaceIdentity: string;
  subject: ContextSubject;
  subjectIdentity: string;
  projectionIdentity: string;
  contextGeneration: string;
  deliveryMode: DeliveryMode;
  deliveredContentIdentity: string;
  snapshotId: string;
  reliability: unknown;
  deliveredAt: string;
  expiresAt?: string;
  priorReceiptId?: string;
  state: "active" | "expired" | "invalid";
  schemaVersion: number;
};

export type DeliveredSnapshot = {
  snapshotId: string;
  receiptId: string;
  subjectIdentity: string;
  projectionIdentity: string;
  content: string;
  contentIdentity: string;
  createdAt: string;
  schemaVersion: number;
};

export type ContextAwareReadResult = {
  mode: DeliveryMode;
  receipt: ContextReceipt;
  current: { contentIdentity: string; reliability: unknown };
  content?: string;
  delta?: unknown;
  reason?: string;
};
