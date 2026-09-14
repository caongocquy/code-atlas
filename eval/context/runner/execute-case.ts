import path from "node:path";

import { prepareContextAwareRead } from "../../../src/core/context/context-delivery-preparation.js";
import { ContextDeliveryPreparationError, type PreparedContextAwareRead } from "../../../src/core/context/context.types.js";
import { compileTaskContextForRepository } from "../../../src/core/context/task-context-repository-compiler.js";
import type { TaskContextDelivery } from "../../../src/core/context/task-context-lifecycle.types.js";
import type { TaskContextItem, TaskContextPlanDetail } from "../../../src/core/context/task-context.types.js";
import { indexRepository } from "../../../src/core/indexing/index-pipeline.service.js";
import { ContextStore } from "../../../src/storage/context/context.store.js";
import { materializeWorkspace } from "../corpus/materialize-workspace.js";
import type { EvalCase, EvalExecutionDeps, ObservedCase, ObservedMetrics } from "../types.js";

function subjectKey(subject: TaskContextItem["subject"]): string {
  return subject.kind === "file"
    ? `file:${subject.path}`
    : `symbol:${subject.path}:${subject.symbolId}:${subject.selectorVersion}`;
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
    const plan = await compile(workspace.root, { task: input.evalCase.task, anchors: input.evalCase.anchors, changedPaths: input.evalCase.changedPaths, detail: "full" });
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
