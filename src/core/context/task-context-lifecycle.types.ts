import type { TaskContextAnchor, TaskContextBudget, TaskContextItem } from "./task-context.types.js";
import type { ContextAwareReadResult } from "./context.types.js";

export type TaskContextLifecycleState = "active" | "expired" | "closed";

export type TaskContextLifecycleBudget = {
  maxItems: number;
  maxEstimatedTokens: number;
};

export type TaskContextLifecycleMetrics = {
  compiledItems: number;
  deliveredItems: number;
  failedItems: number;
  omittedItems: number;
  estimatedTokens: number;
  requestedBytes: number;
  returnedBytes: number;
  savedBytes: number;
  fullReads: number;
  unchangedReads: number;
  deltaReads: number;
  rehydrates: number;
};

type TaskContextDeliveryBase = {
  item: TaskContextItem;
  current: ContextAwareReadResult["current"];
};

export type PreparedContextDelivery =
  | (TaskContextDeliveryBase & { mode: "full" | "rehydrate"; content: string; reason?: string })
  | (TaskContextDeliveryBase & { mode: "delta"; delta: unknown })
  | (TaskContextDeliveryBase & { mode: "unchanged" });

export type TaskContextDelivery = PreparedContextDelivery | {
  item: TaskContextItem;
  mode: "error";
  error: { code: string; message: string };
};

export type TaskContextLifecycle = {
  readonly taskContextId: string;
  readonly repositoryIdentity: string;
  readonly workspaceIdentity: string;
  readonly sessionId: string;
  readonly contextGeneration: string;
  readonly task: string;
  readonly anchors: readonly TaskContextAnchor[];
  readonly taskIdentity: string;
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
  deliveries: TaskContextDelivery[];
  metrics: TaskContextLifecycleMetrics;
  budget: TaskContextBudget;
};

export type StartTaskContextInput = {
  task: string;
  anchors?: TaskContextAnchor[];
  budget?: { maxItems?: number; maxEstimatedTokens?: number };
  ttlSeconds?: number;
  detail?: "compact" | "full";
};

export type RefreshTaskContextInput = {
  taskContextId: string;
  budget?: { maxItems?: number; maxEstimatedTokens?: number };
  detail?: "compact" | "full";
};

export type CloseTaskContextInput = { taskContextId: string };
export type StartTaskContextResult = TaskContextLifecycleResult;
export type RefreshTaskContextResult = TaskContextLifecycleResult;
export type CloseTaskContextResult = { lifecycle: TaskContextLifecycle };

export type TaskContextLifecycleOperation = "start" | "refresh" | "close" | "expire";
export type TaskContextLifecycleOperationErrorCode =
  | "invalid_task_context_id"
  | "lifecycle_not_found"
  | "workspace_mismatch"
  | "lifecycle_conflict"
  | "context_closed"
  | "context_expired"
  | "unsupported_context_schema"
  | "context_database_unavailable"
  | "compiler_validation_failed";

export type TaskContextLifecycleOperationError = {
  code: TaskContextLifecycleOperationErrorCode;
  operation: TaskContextLifecycleOperation;
  message: string;
  taskContextId?: string;
};

export type TaskContextLifecycleError = TaskContextLifecycleOperationError;

export class TaskContextLifecycleDomainError extends Error {
  readonly operationError: TaskContextLifecycleOperationError;

  constructor(operationError: TaskContextLifecycleOperationError) {
    super(operationError.message);
    this.name = "TaskContextLifecycleDomainError";
    this.operationError = operationError;
  }
}
