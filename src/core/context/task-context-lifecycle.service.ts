import path from "node:path";
import { randomUUID } from "node:crypto";

import { ContextStore, ContextStoreOpenError } from "../../storage/context/context.store.js";
import { UnsupportedContextSchemaError } from "../../storage/context/context.schema.js";
import { canonicalRepositoryPath } from "../repository/repository-identity.js";
import { getWorkspaceIdentity } from "./context-identity.js";
import { CONTEXT_AWARE_SOURCE_PROJECTION, prepareContextAwareRead } from "./context-delivery-preparation.js";
import { readCurrentChangedPaths } from "./task-context-lifecycle-changes.js";
import { createTaskIntentIdentity, normalizeLifecycleBudget, normalizeLifecycleTtlSeconds, validateTaskContextId } from "./task-context-lifecycle-identity.js";
import { normalizeTaskContextInput } from "./task-context-normalizer.js";
import { compileTaskContextForRepository, TaskContextRepositoryCompilerError } from "./task-context-repository-compiler.js";
import { ContextDeliveryPreparationError, type PreparedContextAwareRead } from "./context.types.js";
import type { TaskContextPlanDetail } from "./task-context.types.js";
import type { CloseTaskContextInput, CloseTaskContextResult, StartTaskContextInput, RefreshTaskContextInput, TaskContextDelivery, TaskContextLifecycleResult } from "./task-context-lifecycle.types.js";
import { TaskContextLifecycleDomainError } from "./task-context-lifecycle.types.js";

type Clock = () => Date;
export type TaskContextLifecycleDeps = {
  repositoryPath?: string;
  now?: Clock;
  store?: ContextStore;
  compileTaskContextForRepository?: typeof compileTaskContextForRepository;
  prepareContextAwareRead?: typeof prepareContextAwareRead;
  readCurrentChangedPaths?: typeof readCurrentChangedPaths;
};

type LifecycleErrorCode = "invalid_task_context_id" | "lifecycle_not_found" | "task_context_closed" | "task_context_expired" | "repository_mismatch" | "workspace_mismatch" | "lifecycle_conflict" | "unsupported_context_schema" | "context_database_unavailable" | "compiler_validation_failed";

function operationError(code: LifecycleErrorCode, operation: "start" | "refresh" | "close", message: string, taskContextId?: string, expectedRevision?: number, currentRevision?: number): never {
  throw new TaskContextLifecycleDomainError({ code, operation, message, retryable: code === "lifecycle_conflict", ...(taskContextId ? { taskContextId } : {}), ...(expectedRevision !== undefined ? { expectedRevision } : {}), ...(currentRevision !== undefined ? { currentRevision } : {}) });
}

function metrics(plan: TaskContextPlanDetail, prepared: PreparedContextAwareRead[], deliveries: TaskContextDelivery[], previousPlanIdentity?: string) {
  const result = { selectedItems: plan.items.length, deliveredItems: prepared.length, fullItems: 0, deltaItems: 0, unchangedItems: 0, rehydratedItems: 0, failedItems: deliveries.filter((delivery) => delivery.mode === "error").length, requestedBytes: 0, returnedBytes: 0, savedBytes: 0, ...(previousPlanIdentity ? { previousPlanIdentity } : {}), currentPlanIdentity: plan.planIdentity, planChanged: previousPlanIdentity !== undefined && previousPlanIdentity !== plan.planIdentity };
  for (const item of prepared) {
    result.requestedBytes += item.metrics.requestedBytes;
    result.returnedBytes += item.metrics.returnedBytes;
    result.savedBytes += item.metrics.savedBytes;
    if (item.result.mode === "full") result.fullItems += 1;
    if (item.result.mode === "unchanged") result.unchangedItems += 1;
    if (item.result.mode === "delta") result.deltaItems += 1;
    if (item.result.mode === "rehydrate") result.rehydratedItems += 1;
  }
  return result;
}

function mapPrepared(item: TaskContextPlanDetail["items"][number], prepared: PreparedContextAwareRead | undefined): TaskContextDelivery {
  if (prepared) {
    const { mode, current, content, delta, reason } = prepared.result;
    if (mode === "full" || mode === "rehydrate") return { subject: item.subject, receiptId: prepared.receipt.receiptId, reliability: prepared.receipt.reliability, mode, current, content: content as string, ...(reason ? { reason } : {}) };
    if (mode === "delta") return { subject: item.subject, receiptId: prepared.receipt.receiptId, reliability: prepared.receipt.reliability, mode, current, delta };
    return { subject: item.subject, receiptId: prepared.receipt.receiptId, reliability: prepared.receipt.reliability, mode, current };
  }
  return { subject: item.subject, mode: "error", error: { code: "delivery_preparation_failed", message: "Context delivery preparation failed" } };
}

async function prepareItems(root: string, plan: TaskContextPlanDetail, sessionId: string, generation: string, ttlSeconds: number, store: ContextStore, deps: TaskContextLifecycleDeps): Promise<{ prepared: PreparedContextAwareRead[]; deliveries: TaskContextDelivery[] }> {
  const prepared: PreparedContextAwareRead[] = [];
  const deliveries: TaskContextDelivery[] = [];
  for (const item of plan.items) {
    try {
      const value = await (deps.prepareContextAwareRead ?? prepareContextAwareRead)(root, { sessionId, contextGeneration: generation, subject: item.subject, projection: CONTEXT_AWARE_SOURCE_PROJECTION, ttlSeconds }, store);
      prepared.push(value);
      deliveries.push(mapPrepared(item, value));
    } catch (error) {
      if (!(error instanceof ContextDeliveryPreparationError)) throw error;
      const typed = error as { code?: unknown; message?: unknown };
      if (typed.code !== "subject_unavailable" && typed.code !== "symbol_resolution_failed" && typed.code !== "delivery_preparation_failed") throw error;
      deliveries.push({ subject: item.subject, mode: "error", error: { code: typed.code, message: typeof typed.message === "string" ? typed.message : String(error) } });
    }
  }
  return { prepared, deliveries };
}

function storeFor(root: string, deps: TaskContextLifecycleDeps, operation: "start" | "refresh" | "close"): { store: ContextStore; owned: boolean } {
  if (deps.store) return { store: deps.store, owned: false };
  try { return { store: new ContextStore(path.join(root, ".codeatlas", "context.db")), owned: true }; }
  catch (error) {
    if (error instanceof UnsupportedContextSchemaError) operationError("unsupported_context_schema", operation, error.message);
    if (error instanceof ContextStoreOpenError) operationError("context_database_unavailable", operation, error.message);
    throw error;
  }
}

export async function startTaskContext(input: StartTaskContextInput, deps: TaskContextLifecycleDeps = {}): Promise<TaskContextLifecycleResult> {
  const root = canonicalRepositoryPath(path.resolve(input.repoPath ?? deps.repositoryPath ?? process.cwd()));
  const workspace = getWorkspaceIdentity(root);
  const now = (deps.now ?? (() => new Date()))().toISOString();
  const ttlSeconds = normalizeLifecycleTtlSeconds(input.ttlSeconds);
  const budget = normalizeLifecycleBudget(input.budget);
  const normalized = normalizeTaskContextInput({ task: input.task, anchors: input.anchors });
  const taskContextId = randomUUID();
  const sessionId = randomUUID();
  const generation = randomUUID();
  const changedPaths = await (deps.readCurrentChangedPaths ?? readCurrentChangedPaths)(root);
  let plan: TaskContextPlanDetail;
  try { plan = await (deps.compileTaskContextForRepository ?? compileTaskContextForRepository)(root, { task: normalized.task, anchors: normalized.anchors, changedPaths, budget, detail: input.detail }); }
  catch (error) { if (error instanceof TaskContextRepositoryCompilerError || error instanceof TypeError) operationError("compiler_validation_failed", "start", error.message, taskContextId); throw error; }
  const storeInfo = storeFor(root, deps, "start");
  try {
    const deliveries = await prepareItems(root, plan, sessionId, generation, ttlSeconds, storeInfo.store, deps);
    const session = deliveries.prepared[0]?.session ?? { sessionId, repositoryIdentity: workspace.repositoryIdentity, workspaceIdentity: workspace.workspaceIdentity, createdAt: now, lastSeenAt: now, contextGeneration: generation, schemaVersion: 1 };
    const lifecycle = { taskContextId, repositoryIdentity: workspace.repositoryIdentity, workspaceIdentity: workspace.workspaceIdentity, sessionId, contextGeneration: generation, task: normalized.task, anchors: normalized.anchors, taskIntentIdentity: createTaskIntentIdentity(normalized.task, normalized.anchors), defaultBudget: budget, ttlSeconds, latestTaskIdentity: plan.taskIdentity, latestPlanIdentity: plan.planIdentity, revision: 0, state: "active" as const, createdAt: now, lastSeenAt: now, expiresAt: new Date(Date.parse(now) + ttlSeconds * 1000).toISOString(), schemaVersion: 2 };
    const committed = storeInfo.store.createAndCommitStart({ lifecycle, session, prepared: deliveries.prepared });
    return { lifecycle: committed, plan, deliveries: deliveries.deliveries, partial: deliveries.deliveries.some((delivery) => delivery.mode === "error"), metrics: metrics(plan, deliveries.prepared, deliveries.deliveries) };
  } finally { if (storeInfo.owned) storeInfo.store.close(); }
}

export async function refreshTaskContext(input: RefreshTaskContextInput, deps: TaskContextLifecycleDeps = {}): Promise<TaskContextLifecycleResult> {
  const taskContextId = (() => { try { return validateTaskContextId(input.taskContextId); } catch (error) { return operationError("invalid_task_context_id", "refresh", error instanceof Error ? error.message : String(error), input.taskContextId); } })();
  const root = canonicalRepositoryPath(path.resolve(input.repoPath ?? deps.repositoryPath ?? process.cwd()));
  const workspace = getWorkspaceIdentity(root);
  const storeInfo = storeFor(root, deps, "refresh");
  try {
    const current = storeInfo.store.loadLifecycle(taskContextId);
    if (!current) operationError("lifecycle_not_found", "refresh", `lifecycle_not_found: ${taskContextId}`, taskContextId);
    if (current.repositoryIdentity !== workspace.repositoryIdentity) operationError("repository_mismatch", "refresh", `repository_mismatch: ${taskContextId}`, taskContextId);
    if (current.workspaceIdentity !== workspace.workspaceIdentity) operationError("workspace_mismatch", "refresh", `workspace_mismatch: ${taskContextId}`, taskContextId);
    if (current.state === "closed") operationError("task_context_closed", "refresh", `task_context_closed: ${taskContextId}`, taskContextId, current.revision, current.revision);
    if (current.state === "expired") operationError("task_context_expired", "refresh", `task_context_expired: ${taskContextId}`, taskContextId, current.revision, current.revision);
    const initialNow = (deps.now ?? (() => new Date()))().toISOString();
    if (current.expiresAt && Date.parse(initialNow) >= Date.parse(current.expiresAt)) {
      storeInfo.store.expireLifecycle({ taskContextId, expectedRevision: current.revision, now: initialNow, repositoryIdentity: workspace.repositoryIdentity, workspaceIdentity: workspace.workspaceIdentity });
      operationError("task_context_expired", "refresh", `task_context_expired: ${taskContextId}`, taskContextId, current.revision, current.revision + 1);
    }
    const budget = normalizeLifecycleBudget(input.budget ?? current.defaultBudget);
    const changedPaths = await (deps.readCurrentChangedPaths ?? readCurrentChangedPaths)(root);
    let plan: TaskContextPlanDetail;
    try { plan = await (deps.compileTaskContextForRepository ?? compileTaskContextForRepository)(root, { task: current.task, anchors: [...current.anchors], changedPaths, budget, detail: input.detail }); }
    catch (error) { if (error instanceof TaskContextRepositoryCompilerError || error instanceof TypeError) operationError("compiler_validation_failed", "refresh", error.message, taskContextId); throw error; }
    const deliveries = await prepareItems(root, plan, current.sessionId, current.contextGeneration, current.ttlSeconds, storeInfo.store, deps);
    const committed = storeInfo.store.commitRefresh({ taskContextId, expectedRevision: current.revision, now: (deps.now ?? (() => new Date()))().toISOString(), repositoryIdentity: workspace.repositoryIdentity, workspaceIdentity: workspace.workspaceIdentity, prepared: deliveries.prepared, latestTaskIdentity: plan.taskIdentity, latestPlanIdentity: plan.planIdentity });
    return { lifecycle: committed, plan, deliveries: deliveries.deliveries, partial: deliveries.deliveries.some((delivery) => delivery.mode === "error"), metrics: metrics(plan, deliveries.prepared, deliveries.deliveries, current.latestPlanIdentity) };
  } finally { if (storeInfo.owned) storeInfo.store.close(); }
}

export function closeTaskContext(input: CloseTaskContextInput, deps: TaskContextLifecycleDeps = {}): CloseTaskContextResult {
  let taskContextId: string;
  try { taskContextId = validateTaskContextId(input.taskContextId); }
  catch (error) { return operationError("invalid_task_context_id", "close", error instanceof Error ? error.message : String(error), input.taskContextId); }
  const root = canonicalRepositoryPath(path.resolve(input.repoPath ?? deps.repositoryPath ?? process.cwd()));
  const workspace = getWorkspaceIdentity(root);
  const storeInfo = storeFor(root, deps, "close");
  try {
    const current = storeInfo.store.loadLifecycle(taskContextId);
    if (!current) operationError("lifecycle_not_found", "close", `lifecycle_not_found: ${taskContextId}`, taskContextId);
    return { lifecycle: storeInfo.store.closeLifecycle({ taskContextId, expectedRevision: current.revision, now: (deps.now ?? (() => new Date()))().toISOString(), repositoryIdentity: workspace.repositoryIdentity, workspaceIdentity: workspace.workspaceIdentity }) };
  } finally { if (storeInfo.owned) storeInfo.store.close(); }
}
