import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CONTEXT_AWARE_SOURCE_PROJECTION } from "../src/core/context/context-delivery-preparation.js";
import { refreshTaskContext, startTaskContext } from "../src/core/context/task-context-lifecycle.service.js";
import type { TaskContextPlanDetail } from "../src/core/context/task-context.types.js";
import { TaskContextLifecycleDomainError } from "../src/core/context/task-context-lifecycle.types.js";

function plan(items: TaskContextPlanDetail["items"]): TaskContextPlanDetail {
  return {
    taskIdentity: "task-v1-smoke",
    planIdentity: "plan-v1-smoke",
    repositoryIdentity: "repo-smoke",
    workspaceIdentity: "workspace-smoke",
    items,
    budget: { maxItems: 20, maxEstimatedTokens: 4000, selectedItems: items.length, estimatedTokens: items.length, omittedItems: 0, budgetExceeded: false },
    reliability: { mayBeIncomplete: false, capabilityStates: {}, diagnostics: [] },
    capabilityFingerprint: "none",
    compiler: { schemaVersion: 1, strategyVersion: "task-context-v1" },
    projection: { detail: "compact", detailsAvailable: false, omitted: 0, truncated: false },
  };
}

test("real lifecycle smoke preserves exact deliveries across restart and detail modes", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-smoke-"));
  try {
    const sourcePath = path.join(root, "source.ts");
    await writeFile(sourcePath, "one\ntwo\n");
    const item = { subject: { kind: "file" as const, path: "source.ts" }, priority: "required" as const, rank: 1, reasons: ["smoke"] };
    const compile = async (_repoPath: string, input: { detail?: "compact" | "full" }) => ({ ...plan([item]), projection: { detail: input.detail ?? "compact", detailsAvailable: input.detail === "full", omitted: 0, truncated: false } });
    const common = { repositoryPath: root, now: () => new Date("2026-09-13T00:00:00.000Z"), readCurrentChangedPaths: async () => [], compileTaskContextForRepository: compile };

    const started = await startTaskContext({ task: "read source", detail: "full" }, common);
    const startedDelivery = started.deliveries[0] as unknown as { mode: string; content?: string; delta?: unknown };
    assert.equal(startedDelivery.mode, "full");
    assert.equal(startedDelivery.content, "one\ntwo\n");

    const restarted = await refreshTaskContext({ taskContextId: started.lifecycle.taskContextId, detail: "compact" }, common);
    const unchanged = restarted.deliveries[0] as unknown as { mode: string; content?: string; delta?: unknown };
    assert.equal(unchanged.mode, "unchanged");
    assert.equal("content" in unchanged, false);
    assert.equal("delta" in unchanged, false);

    await writeFile(sourcePath, "one\ntwo\nthree\n");
    const changed = await refreshTaskContext({ taskContextId: started.lifecycle.taskContextId, detail: "full" }, common);
    const delta = changed.deliveries[0] as unknown as { mode: string; content?: string; delta?: { operations?: unknown[] } };
    assert.equal(delta.mode, "delta");
    assert.ok(delta.delta);
    assert.equal("content" in delta, false);
    assert.deepEqual(changed.plan.items, started.plan.items);
    assert.equal(changed.lifecycle.sessionId, started.lifecycle.sessionId);
    assert.equal(changed.lifecycle.contextGeneration, started.lifecycle.contextGeneration);
    assert.equal(changed.plan.taskIdentity, started.plan.taskIdentity);
    assert.notDeepEqual(changed.plan.projection, started.plan.projection);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a lifecycle handle does not resume from another worktree", async () => {
  const first = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-worktree-a-"));
  const second = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-worktree-b-"));
  try {
    const compile = async () => plan([]);
    const start = await startTaskContext({ task: "empty smoke task", anchors: [], detail: "compact" }, { repositoryPath: first, compileTaskContextForRepository: compile, readCurrentChangedPaths: async () => [] });
    await assert.rejects(
      refreshTaskContext({ taskContextId: start.lifecycle.taskContextId }, { repositoryPath: second, compileTaskContextForRepository: compile, readCurrentChangedPaths: async () => [] }),
      (error: unknown) => error instanceof TaskContextLifecycleDomainError && error.operationError.code === "lifecycle_not_found",
    );
  } finally {
    await Promise.all([rm(first, { recursive: true, force: true }), rm(second, { recursive: true, force: true })]);
  }
});

assert.equal(CONTEXT_AWARE_SOURCE_PROJECTION, "source-v1");
