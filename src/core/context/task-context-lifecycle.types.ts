import type { TaskContextAnchor, TaskContextPlanDetail } from "./task-context.types.js";
import type { ContextAwareReadResult, ContextReceipt, ContextSession, ContextSubject, DeliveredSnapshot } from "./context.types.js";

export type TaskContextLifecycleState = "active" | "expired" | "closed";

export type TaskContextLifecycleBudget = {
  maxItems: number;
  maxEstimatedTokens: number;
};

export type TaskContextLifecycleMetrics = {
  selectedItems: number;
  deliveredItems: number;
  fullItems: number;
  deltaItems: number;
  unchangedItems: number;
  rehydratedItems: number;
  failedItems: number;
  requestedBytes: number;
  returnedBytes: number;
  savedBytes: number;
  previousPlanIdentity?: string;
  currentPlanIdentity: string;
  planChanged: boolean;
};

type TaskContextDeliveryBase = {
  subject: ContextSubject;
  receiptId: string;
  reliability: unknown;
  current: ContextAwareReadResult["current"];
};

export type PreparedContextDelivery =
  | (TaskContextDeliveryBase & { mode: "full" | "rehydrate"; content: string; reason?: string })
  | (TaskContextDeliveryBase & { mode: "delta"; delta: unknown })
  | (TaskContextDeliveryBase & { mode: "unchanged" });

export type TaskContextDelivery = PreparedContextDelivery | {
  subject: ContextSubject;
  mode: "error";
  error: TaskContextDeliveryError;
};

export type TaskContextDeliveryError = { code: "subject_unavailable" | "symbol_resolution_failed" | "delivery_preparation_failed"; message: string };

export type TaskContextLifecycle = {
  readonly taskContextId: string;
  readonly repositoryIdentity: string;
  readonly workspaceIdentity: string;
  readonly sessionId: string;
  readonly contextGeneration: string;
  readonly task: string;
  readonly anchors: readonly TaskContextAnchor[];
  readonly taskIntentIdentity: string;
  readonly defaultBudget: Readonly<TaskContextLifecycleBudget>;
  readonly ttlSeconds: number;
  latestTaskIdentity?: string;
  latestPlanIdentity?: string;
  revision: number;
  state: TaskContextLifecycleState;
  createdAt: string;
  lastSeenAt: string;
  expiresAt?: string;
  closedAt?: string;
  readonly schemaVersion: number;
};

export type TaskContextLifecycleResult = {
  lifecycle: TaskContextLifecycle;
  plan: TaskContextPlanDetail;
  deliveries: TaskContextDelivery[];
  partial: boolean;
  metrics: TaskContextLifecycleMetrics;
};

export type StartTaskContextInput = {
  repoPath?: string;
  task: string;
  anchors?: TaskContextAnchor[];
  budget?: { maxItems?: number; maxEstimatedTokens?: number };
  ttlSeconds?: number;
  detail?: "compact" | "full";
};

export type RefreshTaskContextInput = {
  repoPath?: string;
  taskContextId: string;
  budget?: { maxItems?: number; maxEstimatedTokens?: number };
  detail?: "compact" | "full";
};

export type CloseTaskContextInput = { repoPath?: string; taskContextId: string };
export type StartTaskContextResult = TaskContextLifecycleResult;
export type RefreshTaskContextResult = TaskContextLifecycleResult;
export type CloseTaskContextResult = { lifecycle: TaskContextLifecycle };

export type TaskContextLifecycleOperation = "start" | "refresh" | "close" | "expire";
export type TaskContextLifecycleOperationErrorCode =
  | "invalid_task_context_id"
  | "lifecycle_not_found"
  | "task_context_closed"
  | "task_context_expired"
  | "repository_mismatch"
  | "workspace_mismatch"
  | "lifecycle_conflict"
  | "unsupported_context_schema"
  | "context_database_unavailable"
  | "compiler_validation_failed";

export type TaskContextLifecycleOperationError = {
  code: TaskContextLifecycleOperationErrorCode;
  operation: TaskContextLifecycleOperation;
  message: string;
  retryable: boolean;
  taskContextId?: string;
  expectedRevision?: number;
  currentRevision?: number;
};

export type TaskContextLifecycleError = TaskContextLifecycleOperationError;

export class TaskContextLifecycleDomainError extends Error {
  readonly payload: TaskContextLifecycleOperationError;
  get operationError(): TaskContextLifecycleOperationError { return this.payload; }

  constructor(operationError: TaskContextLifecycleOperationError) {
    super(operationError.message);
    this.name = "TaskContextLifecycleDomainError";
    this.payload = operationError;
  }
}

export type TaskContextLifecyclePersistence = {
  createAndCommitStart(input: { lifecycle: TaskContextLifecycle; session: ContextSession; prepared: Array<{ session: ContextSession; receipt: ContextReceipt; snapshot: DeliveredSnapshot }> }): TaskContextLifecycle;
  loadLifecycle(taskContextId: string): TaskContextLifecycle | undefined;
  commitRefresh(input: { taskContextId: string; expectedRevision: number; now: string; repositoryIdentity: string; workspaceIdentity: string; prepared: Array<{ session: ContextSession; receipt: ContextReceipt; snapshot: DeliveredSnapshot }>; latestTaskIdentity: string; latestPlanIdentity: string }): TaskContextLifecycle;
  closeLifecycle(input: { taskContextId: string; expectedRevision: number; now: string; repositoryIdentity: string; workspaceIdentity: string }): TaskContextLifecycle;
  expireLifecycle(input: { taskContextId: string; expectedRevision: number; now: string; repositoryIdentity: string; workspaceIdentity: string }): TaskContextLifecycle;
};
