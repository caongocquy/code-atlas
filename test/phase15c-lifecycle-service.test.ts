import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CONTEXT_AWARE_SOURCE_PROJECTION } from "../src/core/context/context-delivery-preparation.js";
import { startTaskContext } from "../src/core/context/task-context-lifecycle.service.js";
import { refreshTaskContext } from "../src/core/context/task-context-lifecycle.service.js";
import { ContextDeliveryPreparationError } from "../src/core/context/context.types.js";
import { ContextStore } from "../src/storage/context/context.store.js";

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
    assert.equal(refreshed.lifecycle.taskIdentity, "task-after");
    assert.ok(calls.every((call) => call.projection === CONTEXT_AWARE_SOURCE_PROJECTION));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("refresh commits expiry without publishing prepared receipts when the final clock check expires", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-expiry-"));
  const times = ["2026-09-13T00:00:00.000Z", "2026-09-13T00:00:00.500Z", "2026-09-13T00:00:02.000Z"];
  const compile = async () => ({ taskIdentity: "task", planIdentity: "plan", repositoryIdentity: "repo", workspaceIdentity: "workspace", items: [{ subject: { kind: "file" as const, path: "source.ts" }, priority: "required" as const, rank: 1, reasons: [] }], budget: { maxItems: 20, maxEstimatedTokens: 4000, selectedItems: 1, estimatedTokens: 1, omittedItems: 0, budgetExceeded: false }, reliability: { mayBeIncomplete: false, capabilityStates: {}, diagnostics: [] }, capabilityFingerprint: "none", compiler: { schemaVersion: 1, strategyVersion: "task-context-v1" }, projection: { detail: "compact" as const, detailsAvailable: false, omitted: 0, truncated: false } });
  try {
    await writeFile(path.join(root, "source.ts"), "one\n");
    const common = { repositoryPath: root, now: () => new Date(times.shift() ?? times.at(-1)!), compileTaskContextForRepository: compile, readCurrentChangedPaths: async () => [] };
    const started = await startTaskContext({ task: "value", ttlSeconds: 1 }, common);
    await assert.rejects(refreshTaskContext({ taskContextId: started.lifecycle.taskContextId }, common), (error: unknown) => error instanceof Error && "operationError" in error && (error as { operationError: { code: string } }).operationError.code === "context_expired");
    const store = new ContextStore(path.join(root, ".codeatlas", "context.db"));
    const expired = store.loadLifecycle(started.lifecycle.taskContextId);
    assert.equal(expired?.state, "expired");
    assert.equal(expired?.revision, 2);
    store.close();
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
      prepareContextAwareRead: async () => { throw new ContextDeliveryPreparationError("missing subject"); },
    });
    assert.equal(result.lifecycle.revision, 1);
    assert.equal(result.metrics.deliveredItems, 0);
    assert.equal(result.deliveries[0]?.mode, "error");
  } finally { await rm(root, { recursive: true, force: true }); }
});
