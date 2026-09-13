import path from "node:path";
import { randomUUID } from "node:crypto";

import { ContextStore, ContextStoreOpenError } from "../../storage/context/context.store.js";
import { UnsupportedContextSchemaError } from "../../storage/context/context.schema.js";
import { canonicalRepositoryPath, getRepositoryIdentity } from "../repository/repository-identity.js";
import { getWorkspaceIdentity } from "./context-identity.js";
import { CONTEXT_AWARE_SOURCE_PROJECTION, prepareContextAwareRead } from "./context-delivery-preparation.js";
import { readCurrentChangedPaths } from "./task-context-lifecycle-changes.js";
import { createTaskIntentIdentity, normalizeLifecycleBudget, normalizeLifecycleTtlSeconds, validateTaskContextId } from "./task-context-lifecycle-identity.js";
import { normalizeTaskContextInput } from "./task-context-normalizer.js";
import { compileTaskContextForRepository } from "./task-context-repository-compiler.js";
import { ContextDeliveryPreparationError, type PreparedContextAwareRead } from "./context.types.js";
import type { TaskContextBudget, TaskContextPlanDetail } from "./task-context.types.js";
import type { CloseTaskContextInput, CloseTaskContextResult, StartTaskContextInput, RefreshTaskContextInput, TaskContextDelivery, TaskContextLifecycle, TaskContextLifecycleMetrics, TaskContextLifecycleResult } from "./task-context-lifecycle.types.js";
import { TaskContextLifecycleDomainError } from "./task-context-lifecycle.types.js";

type Clock = () => Date;
export type TaskContextLifecycleDeps = {
  repositoryPath?: string;
  now?: Clock;
  store?: ContextStore;
  compileTaskContextForRepository?: typeof compileTaskContextForRepository;
  prepareContextAwareRead?: typeof prepareContextAwareRead;
  readCurrentChangedPaths?: typeof readCurrentChangedPaths;
  projection?: string;
};

function operationError(code: any, operation: "start" | "refresh" | "close", message: string, taskContextId?: string): never {
  throw new TaskContextLifecycleDomainError({ code, operation, message, ...(taskContextId ? { taskContextId } : {}) });
}

function metrics(plan: TaskContextPlanDetail, prepared: PreparedContextAwareRead[], deliveries: TaskContextDelivery[]): TaskContextLifecycleMetrics {
  return { compiledItems: plan.items.length, deliveredItems: prepared.length, omittedItems: plan.budget.omittedItems, estimatedTokens: plan.budget.estimatedTokens };
}

function mapPrepared(item: TaskContextPlanDetail["items"][number], prepared: PreparedContextAwareRead | undefined): TaskContextDelivery {
  if (prepared) return { item, mode: prepared.result.mode };
  return { item, mode: "error", error: { code: "context_delivery_failed", message: "Context delivery preparation failed" } };
}

async function prepareItems(root: string, plan: TaskContextPlanDetail, sessionId: string, generation: string, ttlSeconds: number, deps: TaskContextLifecycleDeps): Promise<{ prepared: PreparedContextAwareRead[]; deliveries: TaskContextDelivery[] }> {
  const prepared: PreparedContextAwareRead[] = [];
  const deliveries: TaskContextDelivery[] = [];
  for (const item of plan.items) {
    try {
      const value = await (deps.prepareContextAwareRead ?? prepareContextAwareRead)(root, { sessionId, contextGeneration: generation, subject: item.subject, projection: deps.projection ?? CONTEXT_AWARE_SOURCE_PROJECTION, ttlSeconds });
      prepared.push(value);
      deliveries.push(mapPrepared(item, value));
    } catch (error) {
      if (!(error instanceof ContextDeliveryPreparationError)) throw error;
      deliveries.push({ item, mode: "error", error: { code: "context_delivery_failed", message: error instanceof Error ? error.message : String(error) } });
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
  const root = canonicalRepositoryPath(path.resolve(deps.repositoryPath ?? process.cwd()));
  const workspace = getWorkspaceIdentity(root);
  const repository = getRepositoryIdentity(root);
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
  catch (error) { if (error instanceof TypeError) operationError("compiler_validation_failed", "start", error.message, taskContextId); throw error; }
  const deliveries = await prepareItems(root, plan, sessionId, generation, ttlSeconds, deps);
  const storeInfo = storeFor(root, deps, "start");
  try {
    const session = deliveries.prepared[0]?.session ?? { sessionId, repositoryIdentity: workspace.repositoryIdentity, workspaceIdentity: workspace.workspaceIdentity, createdAt: now, lastSeenAt: now, contextGeneration: generation, schemaVersion: 1 };
    const lifecycle = { taskContextId, repositoryIdentity: workspace.repositoryIdentity, workspaceIdentity: workspace.workspaceIdentity, sessionId, contextGeneration: generation, task: normalized.task, anchors: normalized.anchors, taskIdentity: plan.taskIdentity, taskIntentIdentity: createTaskIntentIdentity(normalized.task, normalized.anchors), defaultBudget: budget, ttlSeconds, latestTaskIdentity: plan.taskIdentity, latestPlanIdentity: plan.planIdentity, revision: 0, state: "active" as const, createdAt: now, lastSeenAt: now, expiresAt: new Date(Date.parse(now) + ttlSeconds * 1000).toISOString(), schemaVersion: 2 };
    const committed = storeInfo.store.createAndCommitStart({ lifecycle, session, prepared: deliveries.prepared });
    return { lifecycle: committed, deliveries: deliveries.deliveries, metrics: metrics(plan, deliveries.prepared, deliveries.deliveries), budget: plan.budget };
  } finally { if (storeInfo.owned) storeInfo.store.close(); }
}

export async function refreshTaskContext(input: RefreshTaskContextInput, deps: TaskContextLifecycleDeps = {}): Promise<TaskContextLifecycleResult> {
  const taskContextId = (() => { try { return validateTaskContextId(input.taskContextId); } catch (error) { return operationError("invalid_task_context_id", "refresh", error instanceof Error ? error.message : String(error), input.taskContextId); } })();
  const root = canonicalRepositoryPath(path.resolve(deps.repositoryPath ?? process.cwd()));
  const workspace = getWorkspaceIdentity(root);
  const storeInfo = storeFor(root, deps, "refresh");
  try {
    const current = storeInfo.store.loadLifecycle(taskContextId);
    if (!current) operationError("context_not_found", "refresh", `context_not_found: ${taskContextId}`, taskContextId);
    if (current.repositoryIdentity !== workspace.repositoryIdentity || current.workspaceIdentity !== workspace.workspaceIdentity) operationError("workspace_mismatch", "refresh", `workspace_mismatch: ${taskContextId}`, taskContextId);
    if (current.state === "closed") operationError("context_closed", "refresh", `context_closed: ${taskContextId}`, taskContextId);
    if (current.state === "expired") operationError("context_expired", "refresh", `context_expired: ${taskContextId}`, taskContextId);
    const initialNow = (deps.now ?? (() => new Date()))().toISOString();
    if (current.expiresAt && Date.parse(initialNow) >= Date.parse(current.expiresAt)) operationError("context_expired", "refresh", `context_expired: ${taskContextId}`, taskContextId);
    const budget = normalizeLifecycleBudget(input.budget ?? current.defaultBudget);
    const changedPaths = await (deps.readCurrentChangedPaths ?? readCurrentChangedPaths)(root);
    let plan: TaskContextPlanDetail;
    try { plan = await (deps.compileTaskContextForRepository ?? compileTaskContextForRepository)(root, { task: current.task, anchors: [...current.anchors], changedPaths, budget, detail: input.detail }); }
    catch (error) { if (error instanceof TypeError) operationError("compiler_validation_failed", "refresh", error.message, taskContextId); throw error; }
    const deliveries = await prepareItems(root, plan, current.sessionId, current.contextGeneration, current.ttlSeconds, deps);
    try {
      const committed = storeInfo.store.commitRefresh({ taskContextId, expectedRevision: current.revision, now: (deps.now ?? (() => new Date()))().toISOString(), repositoryIdentity: workspace.repositoryIdentity, workspaceIdentity: workspace.workspaceIdentity, prepared: deliveries.prepared, latestTaskIdentity: plan.taskIdentity, latestPlanIdentity: plan.planIdentity });
      return { lifecycle: committed, deliveries: deliveries.deliveries, metrics: metrics(plan, deliveries.prepared, deliveries.deliveries), budget: plan.budget };
    } catch (error) { throw error; }
  } finally { if (storeInfo.owned) storeInfo.store.close(); }
}

export function closeTaskContext(input: CloseTaskContextInput, deps: TaskContextLifecycleDeps = {}): CloseTaskContextResult {
  const taskContextId = validateTaskContextId(input.taskContextId);
  const root = canonicalRepositoryPath(path.resolve(deps.repositoryPath ?? process.cwd()));
  const workspace = getWorkspaceIdentity(root);
  const storeInfo = storeFor(root, deps, "close");
  try {
    const current = storeInfo.store.loadLifecycle(taskContextId);
    if (!current) operationError("context_not_found", "close", `context_not_found: ${taskContextId}`, taskContextId);
    return { lifecycle: storeInfo.store.closeLifecycle({ taskContextId, expectedRevision: current.revision, now: (deps.now ?? (() => new Date()))().toISOString(), repositoryIdentity: workspace.repositoryIdentity, workspaceIdentity: workspace.workspaceIdentity }) };
  } finally { if (storeInfo.owned) storeInfo.store.close(); }
}
