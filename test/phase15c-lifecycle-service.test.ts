import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CONTEXT_AWARE_SOURCE_PROJECTION } from "../src/core/context/context-delivery-preparation.js";
import { startTaskContext } from "../src/core/context/task-context-lifecycle.service.js";
import { refreshTaskContext } from "../src/core/context/task-context-lifecycle.service.js";
import { ContextDeliveryPreparationError } from "../src/core/context/context.types.js";
import { ContextStore } from "../src/storage/context/context.store.js";
import type { TaskContextPlanDetail } from "../src/core/context/task-context.types.js";

function fileItem(filePath: string): TaskContextPlanDetail["items"][number] {
  return { subject: { kind: "file", path: filePath }, priority: "required", rank: 1, reasons: ["acceptance"] };
}

function testPlan(items: TaskContextPlanDetail["items"], budget = { maxItems: 20, maxEstimatedTokens: 4000 }, detail: "compact" | "full" = "compact"): TaskContextPlanDetail {
  return {
    taskIdentity: `task-${items.map((item) => item.subject.path).join("-") || "empty"}`,
    planIdentity: `plan-${items.map((item) => item.subject.path).join("-") || "empty"}`,
    repositoryIdentity: "repo",
    workspaceIdentity: "workspace",
    items,
    budget: { ...budget, selectedItems: items.length, estimatedTokens: items.length, omittedItems: 0, budgetExceeded: false },
    reliability: { mayBeIncomplete: false, capabilityStates: {}, diagnostics: [] },
    capabilityFingerprint: "none",
    compiler: { schemaVersion: 1, strategyVersion: "task-context-v1" },
    projection: { detail, detailsAvailable: detail === "full", omitted: 0, truncated: false },
  };
}

test("start creates an opaque revision-one lifecycle and persists the default budget", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-lifecycle-"));
  try {
    await writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
    const result = await startTaskContext({ task: "value", anchors: [{ kind: "file", path: "source.ts" }] }, {
      repositoryPath: root,
      now: () => new Date("2026-09-13T00:00:00.000Z"),
      compileTaskContextForRepository: async (_repoPath, input) => ({
        taskIdentity: "phase15b-task-1", planIdentity: "phase15b-plan-1", repositoryIdentity: "repo", workspaceIdentity: "workspace",
        items: [{ subject: { kind: "file", path: "source.ts" }, priority: "required", rank: 1, reasons: ["anchor"] }],
        budget: { maxItems: input.budget?.maxItems ?? 20, maxEstimatedTokens: input.budget?.maxEstimatedTokens ?? 4000, selectedItems: 1, estimatedTokens: 1, omittedItems: 0, budgetExceeded: false },
        reliability: { mayBeIncomplete: false, capabilityStates: {}, diagnostics: [] }, capabilityFingerprint: "none",
        compiler: { schemaVersion: 1, strategyVersion: "task-context-v1" }, projection: { detail: "compact", detailsAvailable: false, omitted: 0, truncated: false },
      }),
      projection: CONTEXT_AWARE_SOURCE_PROJECTION,
      readCurrentChangedPaths: async () => [],
    });
    assert.match(result.lifecycle.taskContextId, /^[0-9a-f-]{36}$/i);
    assert.equal(result.lifecycle.revision, 1);
    assert.equal(result.lifecycle.ttlSeconds, 86400);
    assert.deepEqual(result.lifecycle.defaultBudget, { maxItems: 20, maxEstimatedTokens: 4000 });
    assert.equal(result.deliveries.length, 1);
    assert.equal(result.metrics.deliveredItems, 1);
    assert.equal(result.metrics.selectedItems, 1);
    assert.equal(result.metrics.fullItems, 1);
    assert.equal(result.metrics.failedItems, 0);
    assert.equal(result.metrics.unchangedItems, 0);
    assert.equal(result.metrics.deltaItems, 0);
    assert.equal(result.metrics.rehydratedItems, 0);
    assert.equal(result.partial, false);
    assert.equal(result.plan.planIdentity, "phase15b-plan-1");
    assert.equal(result.metrics.returnedBytes > 0, true);
    assert.ok(result.metrics.requestedBytes > 0);
    assert.ok(result.metrics.returnedBytes > 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refresh keeps session identity while recompiling current paths and uses the exact projection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-refresh-"));
  const calls: Array<{ changedPaths: string[]; projection: string }> = [];
  try {
    await writeFile(path.join(root, "source.ts"), "one\n");
    const compile = async (_repoPath: string, input: { changedPaths?: string[]; detail?: "compact" | "full" }) => ({
      taskIdentity: input.changedPaths?.length ? "task-after" : "task-before", planIdentity: input.changedPaths?.length ? "plan-after" : "plan-before", repositoryIdentity: "repo", workspaceIdentity: "workspace",
      items: [{ subject: { kind: "file" as const, path: "source.ts" }, priority: "required" as const, rank: 1, reasons: ["test"] }],
      budget: { maxItems: 20, maxEstimatedTokens: 4000, selectedItems: 1, estimatedTokens: 1, omittedItems: 0, budgetExceeded: false }, reliability: { mayBeIncomplete: false, capabilityStates: {}, diagnostics: [] }, capabilityFingerprint: "none", compiler: { schemaVersion: 1, strategyVersion: "task-context-v1" }, projection: { detail: input.detail ?? "compact" as const, detailsAvailable: false, omitted: 0, truncated: false },
    });
    const common = { repositoryPath: root, now: () => new Date("2026-09-13T00:00:00.000Z"), compileTaskContextForRepository: compile, readCurrentChangedPaths: async () => ["source.ts"], prepareContextAwareRead: async (...args: Parameters<typeof import("../src/core/context/context-delivery-preparation.js").prepareContextAwareRead>) => { calls.push({ changedPaths: [args[1].subject.path], projection: args[1].projection }); return (await import("../src/core/context/context-delivery-preparation.js")).prepareContextAwareRead(...args); } };
    const started = await startTaskContext({ task: "value" }, { ...common, readCurrentChangedPaths: async () => [] });
    await writeFile(path.join(root, "source.ts"), "two\n");
    const refreshed = await (await import("../src/core/context/task-context-lifecycle.service.js")).refreshTaskContext({ taskContextId: started.lifecycle.taskContextId }, common);
    assert.equal(refreshed.lifecycle.revision, 2);
    assert.equal(refreshed.lifecycle.sessionId, started.lifecycle.sessionId);
    assert.equal(refreshed.lifecycle.contextGeneration, started.lifecycle.contextGeneration);
    assert.equal(refreshed.lifecycle.latestTaskIdentity, "task-after");
    assert.ok(calls.every((call) => call.projection === CONTEXT_AWARE_SOURCE_PROJECTION));
    assert.equal(refreshed.deliveries[0]?.mode, "delta");
    assert.equal(refreshed.metrics.deltaItems, 1);
    assert.equal(refreshed.metrics.previousPlanIdentity, "plan-before");
    assert.equal(refreshed.metrics.currentPlanIdentity, "plan-after");
    assert.equal(refreshed.metrics.planChanged, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("concurrent refreshes use revision CAS and publish only one operation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-refresh-race-"));
  let release!: () => void;
  let prepared = 0;
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  try {
    await writeFile(path.join(root, "source.ts"), "one\n");
    const common = {
      repositoryPath: root, now: () => new Date("2026-09-13T00:00:00.000Z"), readCurrentChangedPaths: async () => [],
      compileTaskContextForRepository: async () => ({ taskIdentity: "task", planIdentity: "plan", repositoryIdentity: "repo", workspaceIdentity: "workspace", items: [{ subject: { kind: "file" as const, path: "source.ts" }, priority: "required" as const, rank: 1, reasons: [] }], budget: { maxItems: 20, maxEstimatedTokens: 4000, selectedItems: 1, estimatedTokens: 1, omittedItems: 0, budgetExceeded: false }, reliability: { mayBeIncomplete: false, capabilityStates: {}, diagnostics: [] }, capabilityFingerprint: "none", compiler: { schemaVersion: 1, strategyVersion: "task-context-v1" }, projection: { detail: "compact" as const, detailsAvailable: false, omitted: 0, truncated: false } } ),
      prepareContextAwareRead: async (...args: Parameters<typeof import("../src/core/context/context-delivery-preparation.js").prepareContextAwareRead>) => { if (++prepared > 1) await barrier; return (await import("../src/core/context/context-delivery-preparation.js")).prepareContextAwareRead(...args); },
    };
    const started = await startTaskContext({ task: "value" }, { ...common, prepareContextAwareRead: undefined });
    const first = refreshTaskContext({ taskContextId: started.lifecycle.taskContextId }, common);
    const second = refreshTaskContext({ taskContextId: started.lifecycle.taskContextId }, common);
    while (prepared < 2) await new Promise((resolve) => setTimeout(resolve, 1));
    release();
    const results = await Promise.allSettled([first, second]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results.filter((result) => result.status === "rejected").length, 1);
    const store = new ContextStore(path.join(root, ".codeatlas", "context.db"));
    assert.equal((store as unknown as { database: { prepare(sql: string): { get(): { count: number } } } }).database.prepare("SELECT count(*) AS count FROM context_receipts").get().count, 2);
    store.close();
  } finally { release?.(); await rm(root, { recursive: true, force: true }); }
});

test("refresh preparation crossing close does not publish stale rows", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-close-race-"));
  let release!: () => void;
  let resolvePrepared!: () => void;
  const prepared = new Promise<void>((resolve) => { resolvePrepared = resolve; });
  const barrier = new Promise<void>((resolve) => { release = resolve; });
  try {
    await writeFile(path.join(root, "source.ts"), "one\n");
    const common = { repositoryPath: root, now: () => new Date("2026-09-13T00:00:00.000Z"), readCurrentChangedPaths: async () => [], compileTaskContextForRepository: async () => ({ taskIdentity: "task", planIdentity: "plan", repositoryIdentity: "repo", workspaceIdentity: "workspace", items: [{ subject: { kind: "file" as const, path: "source.ts" }, priority: "required" as const, rank: 1, reasons: [] }], budget: { maxItems: 20, maxEstimatedTokens: 4000, selectedItems: 1, estimatedTokens: 0, omittedItems: 0, budgetExceeded: false }, reliability: { mayBeIncomplete: false, capabilityStates: {}, diagnostics: [] }, capabilityFingerprint: "none", compiler: { schemaVersion: 1, strategyVersion: "task-context-v1" }, projection: { detail: "compact" as const, detailsAvailable: false, omitted: 0, truncated: false } }), prepareContextAwareRead: async (...args: Parameters<typeof import("../src/core/context/context-delivery-preparation.js").prepareContextAwareRead>) => { resolvePrepared(); await barrier; return (await import("../src/core/context/context-delivery-preparation.js")).prepareContextAwareRead(...args); } };
    const started = await startTaskContext({ task: "value" }, { ...common, prepareContextAwareRead: undefined });
    const refreshing = refreshTaskContext({ taskContextId: started.lifecycle.taskContextId }, common);
    await prepared;
    const closed = (await import("../src/core/context/task-context-lifecycle.service.js")).closeTaskContext({ taskContextId: started.lifecycle.taskContextId }, common);
    assert.equal(closed.lifecycle.state, "closed");
    release();
    const result = await Promise.allSettled([refreshing]);
    assert.equal(result[0]?.status, "rejected");
    const store = new ContextStore(path.join(root, ".codeatlas", "context.db"));
    assert.equal((store as unknown as { database: { prepare(sql: string): { get(): { count: number } } } }).database.prepare("SELECT count(*) AS count FROM context_receipts").get().count, 1);
    store.close();
  } finally { release?.(); await rm(root, { recursive: true, force: true }); }
});

test("refresh commits expiry without publishing prepared receipts when the final clock check expires", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-expiry-"));
  const times = ["2026-09-13T00:00:00.000Z", "2026-09-13T00:00:00.500Z", "2026-09-13T00:00:02.000Z"];
  const compile = async () => ({ taskIdentity: "task", planIdentity: "plan", repositoryIdentity: "repo", workspaceIdentity: "workspace", items: [{ subject: { kind: "file" as const, path: "source.ts" }, priority: "required" as const, rank: 1, reasons: [] }], budget: { maxItems: 20, maxEstimatedTokens: 4000, selectedItems: 1, estimatedTokens: 1, omittedItems: 0, budgetExceeded: false }, reliability: { mayBeIncomplete: false, capabilityStates: {}, diagnostics: [] }, capabilityFingerprint: "none", compiler: { schemaVersion: 1, strategyVersion: "task-context-v1" }, projection: { detail: "compact" as const, detailsAvailable: false, omitted: 0, truncated: false } });
  let releasePreparation!: () => void;
  let preparationStarted!: () => void;
  const preparationBarrier = new Promise<void>((resolve) => { releasePreparation = resolve; });
  const preparationStartedSignal = new Promise<void>((resolve) => { preparationStarted = resolve; });
  try {
    await writeFile(path.join(root, "source.ts"), "one\n");
    const common = { repositoryPath: root, now: () => new Date(times.shift() ?? times.at(-1)!), compileTaskContextForRepository: compile, readCurrentChangedPaths: async () => [] };
    const started = await startTaskContext({ task: "value", ttlSeconds: 1 }, common);
    const refreshing = refreshTaskContext({ taskContextId: started.lifecycle.taskContextId }, { ...common, prepareContextAwareRead: async (...args: Parameters<typeof import("../src/core/context/context-delivery-preparation.js").prepareContextAwareRead>) => { preparationStarted(); await preparationBarrier; return (await import("../src/core/context/context-delivery-preparation.js")).prepareContextAwareRead(...args); } });
    await preparationStartedSignal;
    releasePreparation();
    await assert.rejects(refreshing, (error: unknown) => error instanceof Error && "payload" in error && (error as { payload: { code: string } }).payload.code === "task_context_expired");
    const store = new ContextStore(path.join(root, ".codeatlas", "context.db"));
    const expired = store.loadLifecycle(started.lifecycle.taskContextId);
    assert.equal(expired?.state, "expired");
    assert.equal(expired?.revision, 2);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refresh atomically expires an initially elapsed lifecycle before returning its typed error", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-initial-expiry-"));
  try {
    await writeFile(path.join(root, "source.ts"), "one\n");
    const compile = async () => testPlan([fileItem("source.ts")]);
    const started = await startTaskContext({ task: "value", ttlSeconds: 1 }, { repositoryPath: root, now: () => new Date("2026-09-13T00:00:00.000Z"), readCurrentChangedPaths: async () => [], compileTaskContextForRepository: compile });
    await assert.rejects(
      refreshTaskContext({ taskContextId: started.lifecycle.taskContextId }, { repositoryPath: root, now: () => new Date("2026-09-13T00:00:01.000Z"), readCurrentChangedPaths: async () => [], compileTaskContextForRepository: compile }),
      (error: unknown) => error instanceof Error && "payload" in error && (error as { payload: Record<string, unknown> }).payload.code === "task_context_expired" && (error as { payload: Record<string, unknown> }).payload.retryable === false,
    );
    const store = new ContextStore(path.join(root, ".codeatlas", "context.db"));
    const expired = store.loadLifecycle(started.lifecycle.taskContextId);
    assert.equal(expired?.state, "expired");
    assert.equal(expired?.revision, 2);
    assert.equal((store as unknown as { database: DatabaseSync }).database.prepare("SELECT count(*) AS count FROM context_receipts").get().count, 1);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("lifecycle identity failures distinguish repository mismatch from workspace mismatch", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-identity-mismatch-"));
  try {
    await writeFile(path.join(root, "source.ts"), "one\n");
    const deps = { repositoryPath: root, readCurrentChangedPaths: async () => [], compileTaskContextForRepository: async () => testPlan([fileItem("source.ts")]) };
    const started = await startTaskContext({ task: "value" }, deps);
    const database = new DatabaseSync(path.join(root, ".codeatlas", "context.db"));
    database.prepare("UPDATE task_context_lifecycles SET repository_identity = 'other-repository' WHERE task_context_id = ?").run(started.lifecycle.taskContextId);
    database.close();
    await assert.rejects(refreshTaskContext({ taskContextId: started.lifecycle.taskContextId }, deps), (error: unknown) => error instanceof Error && "payload" in error && (error as { payload: { code: string } }).payload.code === "repository_mismatch");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("all subject-local preparation failures still commit a valid lifecycle with zero deliveries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-delivery-errors-"));
  try {
    const result = await startTaskContext({ task: "value" }, {
      repositoryPath: root,
      now: () => new Date("2026-09-13T00:00:00.000Z"),
      readCurrentChangedPaths: async () => [],
      compileTaskContextForRepository: async () => ({ taskIdentity: "task", planIdentity: "plan", repositoryIdentity: "repo", workspaceIdentity: "workspace", items: [{ subject: { kind: "file" as const, path: "missing.ts" }, priority: "required" as const, rank: 1, reasons: [] }], budget: { maxItems: 20, maxEstimatedTokens: 4000, selectedItems: 1, estimatedTokens: 1, omittedItems: 0, budgetExceeded: false }, reliability: { mayBeIncomplete: false, capabilityStates: {}, diagnostics: [] }, capabilityFingerprint: "none", compiler: { schemaVersion: 1, strategyVersion: "task-context-v1" }, projection: { detail: "compact" as const, detailsAvailable: false, omitted: 0, truncated: false } }),
      prepareContextAwareRead: async () => { throw new ContextDeliveryPreparationError("subject_unavailable", "missing subject"); },
    });
    assert.equal(result.lifecycle.revision, 1);
    assert.equal(result.metrics.deliveredItems, 0);
    assert.equal(result.deliveries[0]?.mode, "error");
    assert.deepEqual(result.deliveries[0]?.mode === "error" ? result.deliveries[0].error : undefined, { code: "subject_unavailable", message: "missing subject" });
    assert.equal(result.partial, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refresh delivers a newly selected subject fully and omits a dropped subject", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-subject-changes-"));
  try {
    await writeFile(path.join(root, "kept.ts"), "kept-v1\n");
    await writeFile(path.join(root, "new.ts"), "new-v1\n");
    let refresh = false;
    const compileTaskContextForRepository = async () => testPlan(refresh ? [fileItem("new.ts")] : [fileItem("kept.ts")]);
    const deps = { repositoryPath: root, now: () => new Date("2026-09-13T00:00:00.000Z"), readCurrentChangedPaths: async () => [], compileTaskContextForRepository };
    const started = await startTaskContext({ task: "subjects" }, deps);
    assert.deepEqual(started.deliveries.map((delivery) => delivery.subject.path), ["kept.ts"]);
    refresh = true;
    const refreshed = await refreshTaskContext({ taskContextId: started.lifecycle.taskContextId }, deps);
    assert.deepEqual(refreshed.deliveries.map((delivery) => delivery.subject.path), ["new.ts"]);
    assert.equal(refreshed.deliveries[0]?.mode, "full");
    assert.equal(refreshed.deliveries[0]?.mode === "full" ? refreshed.deliveries[0].content : undefined, "new-v1\n");
    assert.equal(refreshed.metrics.deliveredItems, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("partial refresh commits successful items without a receipt for the failed item", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-partial-failure-"));
  try {
    await writeFile(path.join(root, "good.ts"), "good\n");
    const items = [fileItem("good.ts"), fileItem("missing.ts")];
    const deps = {
      repositoryPath: root,
      now: () => new Date("2026-09-13T00:00:00.000Z"),
      readCurrentChangedPaths: async () => [],
      compileTaskContextForRepository: async () => testPlan(items),
    };
    const result = await startTaskContext({ task: "partial" }, deps);
    assert.equal(result.lifecycle.revision, 1);
    assert.equal(result.metrics.deliveredItems, 1);
    assert.equal(result.metrics.failedItems, 1);
    assert.deepEqual(result.deliveries.map((delivery) => delivery.mode), ["full", "error"]);
    const store = new ContextStore(path.join(root, ".codeatlas", "context.db"));
    assert.equal((store as unknown as { database: { prepare(sql: string): { get(): { count: number } } } }).database.prepare("SELECT count(*) AS count FROM context_receipts").get().count, 1);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("all selected item failures return a partial lifecycle result without durable deliveries", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-all-failure-"));
  try {
    const items = [fileItem("missing-a.ts"), fileItem("missing-b.ts")];
    const result = await startTaskContext({ task: "all fail" }, {
      repositoryPath: root,
      now: () => new Date("2026-09-13T00:00:00.000Z"),
      readCurrentChangedPaths: async () => [],
      compileTaskContextForRepository: async () => testPlan(items),
    });
    assert.equal(result.lifecycle.state, "active");
    assert.equal(result.metrics.deliveredItems, 0);
    assert.equal(result.metrics.failedItems, 2);
    assert.deepEqual(result.deliveries.map((delivery) => delivery.mode), ["error", "error"]);
    const store = new ContextStore(path.join(root, ".codeatlas", "context.db"));
    assert.equal((store as unknown as { database: { prepare(sql: string): { get(): { count: number } } } }).database.prepare("SELECT count(*) AS count FROM context_receipts").get().count, 0);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refresh budget overrides are ephemeral while persisted TTL is reused after restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-budget-ttl-"));
  const calls: Array<{ maxItems: number | undefined; maxEstimatedTokens: number | undefined }> = [];
  try {
    await writeFile(path.join(root, "source.ts"), "source\n");
    const compileTaskContextForRepository = async (_repoPath: string, input: { budget?: { maxItems?: number; maxEstimatedTokens?: number } }) => {
      calls.push({ maxItems: input.budget?.maxItems, maxEstimatedTokens: input.budget?.maxEstimatedTokens });
      const budget = { maxItems: input.budget?.maxItems ?? 3, maxEstimatedTokens: input.budget?.maxEstimatedTokens ?? 300 };
      return testPlan([fileItem("source.ts")], budget);
    };
    const common = { repositoryPath: root, readCurrentChangedPaths: async () => [], compileTaskContextForRepository };
    const started = await startTaskContext({ task: "budget", budget: { maxItems: 3, maxEstimatedTokens: 300 }, ttlSeconds: 10 }, { ...common, now: () => new Date("2026-09-13T00:00:00.000Z") });
    const refreshed = await refreshTaskContext({ taskContextId: started.lifecycle.taskContextId, budget: { maxItems: 1, maxEstimatedTokens: 2 } }, { ...common, now: () => new Date("2026-09-13T00:00:05.000Z") });
    assert.deepEqual(calls, [{ maxItems: 3, maxEstimatedTokens: 300 }, { maxItems: 1, maxEstimatedTokens: 2 }]);
    assert.deepEqual(refreshed.lifecycle.defaultBudget, { maxItems: 3, maxEstimatedTokens: 300 });
    assert.deepEqual(refreshed.plan.budget, { maxItems: 1, maxEstimatedTokens: 2, selectedItems: 1, estimatedTokens: 1, omittedItems: 0, budgetExceeded: false });
    assert.equal(refreshed.lifecycle.ttlSeconds, 10);
    assert.equal(refreshed.lifecycle.expiresAt, "2026-09-13T00:00:15.000Z");
    const restarted = await refreshTaskContext({ taskContextId: started.lifecycle.taskContextId }, { ...common, now: () => new Date("2026-09-13T00:00:14.000Z") });
    assert.deepEqual(calls[2], { maxItems: 3, maxEstimatedTokens: 300 });
    assert.equal(restarted.lifecycle.ttlSeconds, 10);
    assert.equal(restarted.lifecycle.expiresAt, "2026-09-13T00:00:24.000Z");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("equivalent independent lifecycles keep exact delivery equal across compact and full detail modes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-parity-"));
  try {
    const sourcePath = path.join(root, "source.ts");
    await writeFile(sourcePath, "one\n");
    let content = "one\n";
    const item = fileItem("source.ts");
    const compileTaskContextForRepository = async (_repoPath: string, input: { detail?: "compact" | "full" }) => ({ ...testPlan([item], undefined, input.detail ?? "compact"), projection: { detail: input.detail ?? "compact", detailsAvailable: input.detail === "full", omitted: 0, truncated: false } });
    const deps = { repositoryPath: root, now: () => new Date("2026-09-13T00:00:00.000Z"), readCurrentChangedPaths: async () => [], compileTaskContextForRepository };
    const lifecycleA = await startTaskContext({ task: "same" }, { ...deps, detail: undefined });
    const lifecycleB = await startTaskContext({ task: "same" }, { ...deps, detail: undefined });
    content = "one\ntwo\n";
    await writeFile(sourcePath, content);
    const compact = await refreshTaskContext({ taskContextId: lifecycleA.lifecycle.taskContextId, detail: "compact" }, deps);
    const full = await refreshTaskContext({ taskContextId: lifecycleB.lifecycle.taskContextId, detail: "full" }, deps);
    const shape = (delivery: (typeof compact.deliveries)[number]) => delivery.mode === "error" ? { path: delivery.subject.path, mode: delivery.mode, error: delivery.error } : { path: delivery.subject.path, mode: delivery.mode, current: delivery.current, ...(delivery.mode === "delta" ? { delta: delivery.delta } : {}), ...(delivery.mode === "full" || delivery.mode === "rehydrate" ? { content: delivery.content } : {}) };
    assert.deepEqual(compact.deliveries.map(shape), full.deliveries.map(shape));
    assert.equal(compact.deliveries.some((delivery) => delivery.mode === "unchanged" && "content" in delivery), false);
    assert.deepEqual(compact.plan.budget, full.plan.budget);
    assert.equal(compact.lifecycle.latestTaskIdentity, full.lifecycle.latestTaskIdentity);
    assert.equal(compact.lifecycle.latestPlanIdentity, full.lifecycle.latestPlanIdentity);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("metrics are isolated per concurrent lifecycle operation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-metrics-"));
  try {
    await writeFile(path.join(root, "source.ts"), "one\n");
    const deps = { repositoryPath: root, readCurrentChangedPaths: async () => [], compileTaskContextForRepository: async () => ({ taskIdentity: "task", planIdentity: "plan", repositoryIdentity: "repo", workspaceIdentity: "workspace", items: [{ subject: { kind: "file" as const, path: "source.ts" }, priority: "required" as const, rank: 1, reasons: [] }], budget: { maxItems: 20, maxEstimatedTokens: 4000, selectedItems: 1, estimatedTokens: 0, omittedItems: 0, budgetExceeded: false }, reliability: { mayBeIncomplete: false, capabilityStates: {}, diagnostics: [] }, capabilityFingerprint: "none", compiler: { schemaVersion: 1, strategyVersion: "task-context-v1" }, projection: { detail: "compact" as const, detailsAvailable: false, omitted: 0, truncated: false } }) };
    const store = new ContextStore(path.join(root, ".codeatlas", "context.db"));
    let preparedCount = 0;
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => { release = resolve; });
    const concurrentDeps = { ...deps, store, prepareContextAwareRead: async (...args: Parameters<typeof import("../src/core/context/context-delivery-preparation.js").prepareContextAwareRead>) => { preparedCount += 1; if (preparedCount === 2) release(); await barrier; return (await import("../src/core/context/context-delivery-preparation.js")).prepareContextAwareRead(...args); } };
    const [first, second] = await Promise.all([startTaskContext({ task: "value" }, concurrentDeps), startTaskContext({ task: "value" }, concurrentDeps)]);
    assert.ok(first.metrics.requestedBytes > 0);
    assert.ok(second.metrics.requestedBytes > 0);
    assert.notEqual(first.lifecycle.taskContextId, second.lifecycle.taskContextId);
    assert.equal(first.metrics.requestedBytes, second.metrics.requestedBytes);
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});
