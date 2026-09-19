import path from "node:path";
import { mkdtemp, rm, writeFile as fsWriteFile } from "node:fs/promises";
import { tmpdir } from "node:os";

import { prepareContextAwareRead } from "../../../src/core/context/context-delivery-preparation.js";
import { ContextDeliveryPreparationError, type PreparedContextAwareRead } from "../../../src/core/context/context.types.js";
import { applyDelta } from "../../../src/core/context/context-delta.js";
import { refreshTaskContext, startTaskContext } from "../../../src/core/context/task-context-lifecycle.service.js";
import { TaskContextLifecycleDomainError, type TaskContextDelivery, type TaskContextLifecycleResult } from "../../../src/core/context/task-context-lifecycle.types.js";
import { compileTaskContextForRepository } from "../../../src/core/context/task-context-repository-compiler.js";
import type { TaskContextItem, TaskContextPlanDetail } from "../../../src/core/context/task-context.types.js";
import { indexRepository } from "../../../src/core/indexing/index-pipeline.service.js";
import { ContextStore } from "../../../src/storage/context/context.store.js";
import { canonicalContextSubjectKey } from "../../../src/core/context/task-context-normalizer.js";
import type { DeliveryMode } from "../types.js";
import { materializeWorkspace } from "../corpus/materialize-workspace.js";
import type { EvalCase, EvalExecutionDeps, EvalLifecycleDeps, LifecycleObserved, ObservedCase, ObservedMetrics, ScenarioPrimitive } from "../types.js";

type PublicationCounts = { receipts: number; snapshots: number };

function publicationCounts(store: unknown): PublicationCounts | undefined {
  const database = (store as { database?: { prepare(sql: string): { get(): { count?: number } } } }).database;
  if (!database) return undefined;
  const receipts = database.prepare("SELECT count(*) AS count FROM context_receipts").get().count;
  const snapshots = database.prepare("SELECT count(*) AS count FROM context_snapshots").get().count;
  return typeof receipts === "number" && typeof snapshots === "number" ? { receipts, snapshots } : undefined;
}

function lifecycleSubjectKey(subject: TaskContextDelivery["subject"]): string {
  return subject.kind === "file" ? `file:${subject.path}` : `symbol:${subject.path}:${subject.symbolId}:${subject.selectorVersion}`;
}

function appendLifecycleResult(input: {
  result: TaskContextLifecycleResult;
  modes: DeliveryMode[];
  sessionIds: string[];
  contextGenerations: string[];
  reconstructedContents: Record<string, string>;
  metrics: { fullItems: number; deltaItems: number; unchangedItems: number; rehydratedItems: number; requestedBytes: number; returnedBytes: number; savedBytes: number };
}): void {
  input.sessionIds.push(input.result.lifecycle.sessionId);
  input.contextGenerations.push(input.result.lifecycle.contextGeneration);
  for (const delivery of input.result.deliveries) {
    input.modes.push(delivery.mode);
    if (delivery.mode === "error") continue;
    const key = lifecycleSubjectKey(delivery.subject);
    if (delivery.mode === "full" || delivery.mode === "rehydrate") input.reconstructedContents[key] = delivery.content;
    else if (delivery.mode === "delta") input.reconstructedContents[key] = applyDelta(input.reconstructedContents[key] ?? "", delivery.delta as Parameters<typeof applyDelta>[1]);
    if (delivery.mode === "full") input.metrics.fullItems += 1;
    if (delivery.mode === "delta") input.metrics.deltaItems += 1;
    if (delivery.mode === "unchanged") input.metrics.unchangedItems += 1;
    if (delivery.mode === "rehydrate") input.metrics.rehydratedItems += 1;
  }
  input.metrics.requestedBytes += input.result.metrics.requestedBytes;
  input.metrics.returnedBytes += input.result.metrics.returnedBytes;
  input.metrics.savedBytes += input.result.metrics.savedBytes;
}

function isLifecyclePrimitive(value: ScenarioPrimitive, kind: ScenarioPrimitive["kind"]): boolean {
  return value.kind === kind;
}

async function lifecycleWorkspace(root: string, deps: EvalLifecycleDeps, store: ContextStore, taskContextId: string): Promise<TaskContextLifecycleResult> {
  return (deps.refreshTaskContext ?? refreshTaskContext)({ taskContextId, repoPath: root, detail: "full" }, { ...deps.lifecycleDeps, repositoryPath: root, store });
}

export async function executeLifecycleScenario(input: { evalCase: EvalCase; root: string }, deps: EvalLifecycleDeps = {}): Promise<LifecycleObserved> {
  const scenario = input.evalCase.lifecycle;
  if (!scenario) throw new TypeError(`Lifecycle scenario is required for ${input.evalCase.caseId}`);
  const databasePath = path.join(input.root, ".codeatlas", "context.db");
  const createStore = deps.createContextStore ?? ((database: string) => new ContextStore(database));
  let ownsStore = !deps.lifecycleDeps?.store;
  let store = deps.lifecycleDeps?.store ?? createStore(databasePath);
  const lifecycleDeps = { ...deps.lifecycleDeps, repositoryPath: input.root, store };
  const modes: DeliveryMode[] = [];
  const sessionIds: string[] = [];
  const contextGenerations: string[] = [];
  const reconstructedContents: Record<string, string> = {};
  const totals = { fullItems: 0, deltaItems: 0, unchangedItems: 0, rehydratedItems: 0, requestedBytes: 0, returnedBytes: 0, savedBytes: 0 };
  let started: TaskContextLifecycleResult | undefined;
  let restarted = false;
  let refreshAfterRestart = false;
  try {
    for (const primitive of scenario.primitives) {
      if (isLifecyclePrimitive(primitive, "start")) {
        if (started) throw new TypeError("Lifecycle scenario may start only once");
        started = await (deps.startTaskContext ?? startTaskContext)({ repoPath: input.root, task: input.evalCase.task, anchors: [...input.evalCase.anchors], detail: "full" }, lifecycleDeps);
        appendLifecycleResult({ result: started, modes, sessionIds, contextGenerations, reconstructedContents, metrics: totals });
        continue;
      }
      if (!started) throw new TypeError("Lifecycle scenario must start before other primitives");
      if (primitive.kind === "mutate") {
        for (const [relativePath, content] of Object.entries(primitive.files)) await (deps.writeFile ?? fsWriteFile)(path.join(input.root, relativePath), content, "utf8");
        continue;
      }
      if (primitive.kind === "restart") {
        if (restarted) throw new TypeError("Lifecycle scenario may restart only once");
        if (ownsStore) store.close();
        store = createStore(databasePath);
        lifecycleDeps.store = store;
        ownsStore = true;
        restarted = true;
        continue;
      }
      if (primitive.kind !== "refresh") throw new TypeError(`Unsupported lifecycle primitive: ${primitive.kind}`);
      const refreshStart = modes.length;
      const refreshed = await lifecycleWorkspace(input.root, deps, store, started.lifecycle.taskContextId);
      refreshAfterRestart ||= restarted;
      appendLifecycleResult({ result: refreshed, modes, sessionIds, contextGenerations, reconstructedContents, metrics: totals });
      if (primitive.expectedModeSequence && JSON.stringify(modes.slice(refreshStart)) !== JSON.stringify(primitive.expectedModeSequence)) {
        throw new Error(`Lifecycle refresh mode sequence mismatch: expected ${primitive.expectedModeSequence.join(",")}, observed ${modes.slice(refreshStart).join(",")}`);
      }
      started = refreshed;
    }
    if (!started) throw new TypeError("Lifecycle scenario did not start");

    let crossWorkspaceRefused = false;
    const otherRoot = await mkdtemp(path.join(tmpdir(), "code-atlas-context-eval-cross-workspace-"));
    try {
      const otherStore = createStore(path.join(otherRoot, ".codeatlas", "context.db"));
      try {
        await (deps.refreshTaskContext ?? refreshTaskContext)({ taskContextId: started.lifecycle.taskContextId, repoPath: otherRoot }, { ...deps.lifecycleDeps, repositoryPath: otherRoot, store: otherStore });
      } catch (error) {
        crossWorkspaceRefused = error instanceof TaskContextLifecycleDomainError && error.operationError.code === "lifecycle_not_found";
      } finally { otherStore.close(); }
    } finally { await rm(otherRoot, { recursive: true, force: true }); }

    let casLoserWroteNoStrayState = false;
    const before = publicationCounts(store);
    if (before && "commitRefresh" in store) {
      try {
        store.commitRefresh({ taskContextId: started.lifecycle.taskContextId, expectedRevision: Math.max(0, started.lifecycle.revision - 1), now: (deps.lifecycleDeps?.now ?? (() => new Date()))().toISOString(), repositoryIdentity: started.lifecycle.repositoryIdentity, workspaceIdentity: started.lifecycle.workspaceIdentity, prepared: [], latestTaskIdentity: started.lifecycle.latestTaskIdentity ?? "", latestPlanIdentity: started.lifecycle.latestPlanIdentity ?? "" });
      } catch (error) {
        const after = publicationCounts(store);
        casLoserWroteNoStrayState = error instanceof TaskContextLifecycleDomainError && error.operationError.code === "lifecycle_conflict" && JSON.stringify(before) === JSON.stringify(after);
      }
    }
    return {
      modes,
      ...totals,
      reuseRate: totals.requestedBytes === 0 ? 0 : totals.savedBytes / totals.requestedBytes,
      bodyResendCount: totals.fullItems + totals.rehydratedItems,
      sessionIds,
      contextGenerations,
      crossWorkspaceRefused,
      restartContinuity: !scenario.primitives.some((primitive) => primitive.kind === "restart") || refreshAfterRestart,
      casLoserWroteNoStrayState,
      reconstructedContents,
    };
  } finally {
    if (ownsStore) store.close();
  }
}

function subjectKey(subject: TaskContextItem["subject"]): string {
  return canonicalContextSubjectKey(subject);
}

function mapPrepared(item: TaskContextItem, prepared: PreparedContextAwareRead): TaskContextDelivery {
  const { mode, current, content, delta, reason } = prepared.result;
  if (mode === "full" || mode === "rehydrate") return { subject: item.subject, receiptId: prepared.receipt.receiptId, reliability: prepared.receipt.reliability, mode, current, content: content as string, ...(reason ? { reason } : {}) };
  if (mode === "delta") return { subject: item.subject, receiptId: prepared.receipt.receiptId, reliability: prepared.receipt.reliability, mode, current, delta };
  return { subject: item.subject, receiptId: prepared.receipt.receiptId, reliability: prepared.receipt.reliability, mode, current };
}

function metrics(input: { evalCase: EvalCase; plan: TaskContextPlanDetail; prepared: readonly PreparedContextAwareRead[]; deliveries: readonly TaskContextDelivery[]; indexLoad: number; compile: number }): ObservedMetrics {
  const selected = new Set(input.plan.items.map((item) => subjectKey(item.subject)));
  const hits = (subjects: readonly TaskContextItem["subject"][]) => subjects.filter((subject) => selected.has(subjectKey(subject))).length;
  const required = input.evalCase.truth.requiredSubjects;
  const supporting = input.evalCase.truth.supportingSubjects;
  const requestedBytes = input.prepared.reduce((total, item) => total + item.metrics.requestedBytes, 0);
  const returnedBytes = input.prepared.reduce((total, item) => total + item.metrics.returnedBytes, 0);
  const savedBytes = input.prepared.reduce((total, item) => total + item.metrics.savedBytes, 0);
  const selectedTruth = new Set([...required, ...supporting].map(subjectKey));
  const counts = { full: 0, delta: 0, unchanged: 0, rehydrate: 0 };
  for (const delivery of input.deliveries) {
    if (delivery.mode === "full") counts.full += 1;
    if (delivery.mode === "delta") counts.delta += 1;
    if (delivery.mode === "unchanged") counts.unchanged += 1;
    if (delivery.mode === "rehydrate") counts.rehydrate += 1;
  }
  return {
    selectedItems: input.plan.items.length,
    estimatedTokens: input.plan.budget.estimatedTokens,
    returnedBytes,
    requiredHitRate: required.length === 0 ? 1 : hits(required) / required.length,
    supportingHitRate: supporting.length === 0 ? 1 : hits(supporting) / supporting.length,
    contextPrecision: input.plan.items.length === 0 ? 1 : input.plan.items.filter((item) => selectedTruth.has(subjectKey(item.subject))).length / input.plan.items.length,
    fullItems: counts.full,
    deltaItems: counts.delta,
    unchangedItems: counts.unchanged,
    rehydratedItems: counts.rehydrate,
    requestedBytes,
    savedBytes,
    reuseRate: requestedBytes === 0 ? 0 : savedBytes / requestedBytes,
    bodyResendCount: counts.full + counts.rehydrate,
    timingsMs: { indexLoad: input.indexLoad, compile: input.compile, lifecycleStart: 0, refresh: 0 },
  };
}

export async function executeCase(input: { evalCase: EvalCase; fixtureRoot: string }, deps: EvalExecutionDeps = {}): Promise<ObservedCase> {
  const workspace = await materializeWorkspace({ case: input.evalCase, fixtureRoot: input.fixtureRoot });
  const index = deps.indexRepository ?? indexRepository;
  const compile = deps.compileTaskContextForRepository ?? compileTaskContextForRepository;
  const prepare = deps.prepareContextAwareRead ?? prepareContextAwareRead;
  const createStore = deps.createContextStore ?? ((databasePath: string) => new ContextStore(databasePath));
  const now = deps.now ?? (() => new Date().toISOString());
  try {
    const indexStartedAt = performance.now();
    if (workspace.git) await index(workspace.root);
    else await index(workspace.root, { skipGit: true });
    const indexLoad = performance.now() - indexStartedAt;
    const compileStartedAt = performance.now();
    const plan = await compile(workspace.root, { task: input.evalCase.task, anchors: [...input.evalCase.anchors], changedPaths: [...input.evalCase.changedPaths], detail: "full" });
    const compileDuration = performance.now() - compileStartedAt;
    const store = createStore(path.join(workspace.root, ".codeatlas", "context.db"));
    try {
      const deliveries: TaskContextDelivery[] = [];
      const prepared: PreparedContextAwareRead[] = [];
      const reconstructedContents: Record<string, string> = {};
      for (const item of plan.items) {
        try {
          const value = await prepare(workspace.root, { sessionId: `${input.evalCase.caseId}:session`, contextGeneration: `${input.evalCase.caseId}:generation`, subject: item.subject, projection: "source-v1" }, { store, now }, undefined);
          prepared.push(value);
          deliveries.push(mapPrepared(item, value));
          reconstructedContents[subjectKey(item.subject)] = value.snapshot.content;
        } catch (error) {
          if (!(error instanceof ContextDeliveryPreparationError)) throw error;
          deliveries.push({ subject: item.subject, mode: "error", error: { code: error.code, message: error.message } });
        }
      }
      return {
        caseId: input.evalCase.caseId,
        repositoryIdentity: plan.repositoryIdentity,
        workspaceIdentity: plan.workspaceIdentity,
        taskIdentity: plan.taskIdentity,
        planIdentity: plan.planIdentity,
        selectedItems: plan.items,
        reliability: plan.reliability,
        deliveries,
        reconstructedContents,
        lifecycleModes: deliveries.map((delivery) => delivery.mode),
        metrics: metrics({ evalCase: input.evalCase, plan, prepared, deliveries, indexLoad, compile: compileDuration }),
      };
    } finally {
      store.close();
    }
  } finally {
    await workspace.cleanup();
  }
}
