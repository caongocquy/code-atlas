import assert from "node:assert/strict";
import test from "node:test";

import { budgetTaskContext, DEFAULT_TASK_CONTEXT_BUDGET } from "../src/core/context/task-context-budget.js";
import { createTaskIntentIdentity, normalizeLifecycleBudget, normalizeLifecycleTtlSeconds, validateTaskContextId } from "../src/core/context/task-context-lifecycle-identity.js";
import { TaskContextLifecycleDomainError } from "../src/core/context/task-context-lifecycle.types.js";
import type { TaskContextDelivery, TaskContextLifecycle } from "../src/core/context/task-context-lifecycle.types.js";
import { normalizeTaskContextInput } from "../src/core/context/task-context-normalizer.js";
import type { TaskContextFullItem } from "../src/core/context/task-context.types.js";

test("task intent identity is normalized, path-independent, and versioned", () => {
  const first = normalizeTaskContextInput({
    task: "  inspect fooBar ",
    anchors: [{ kind: "file", path: "src/index.ts" }],
    changedPaths: ["src/index.ts"],
  });
  const equivalent = normalizeTaskContextInput({
    task: "inspect fooBar",
    anchors: [{ kind: "file", path: "src/index.ts" }],
    changedPaths: ["src/other.ts"],
  });

  const firstIdentity = createTaskIntentIdentity(first.task, first.anchors);
  assert.match(firstIdentity, /^task-intent-v1:[0-9a-f]{64}$/);
  assert.equal(firstIdentity, createTaskIntentIdentity(equivalent.task, equivalent.anchors));
  assert.notEqual(firstIdentity, createTaskIntentIdentity("inspect other", first.anchors));
});

test("lifecycle TTL accepts only positive integer seconds through the maximum", () => {
  assert.equal(normalizeLifecycleTtlSeconds(undefined), 86_400);
  assert.equal(normalizeLifecycleTtlSeconds(2_592_000), 2_592_000);
  for (const value of [0, 2_592_001, 1.5]) assert.throws(() => normalizeLifecycleTtlSeconds(value), /TTL/);
});

test("lifecycle and Phase15B budgets share the exported defaults", () => {
  assert.deepEqual(DEFAULT_TASK_CONTEXT_BUDGET, { maxItems: 20, maxEstimatedTokens: 4000 });
  assert.deepEqual(normalizeLifecycleBudget(undefined), DEFAULT_TASK_CONTEXT_BUDGET);
  assert.deepEqual(normalizeLifecycleBudget({ maxItems: 3 }), { maxItems: 3, maxEstimatedTokens: 4000 });

  const items = Array.from({ length: 21 }, (_, index): TaskContextFullItem => ({
    subject: { kind: "file", path: `src/${index}.ts` },
    priority: "optional",
    rank: 1,
    reasons: [],
    scoreSignal: 0,
    evidence: [],
    fusion: { sourceRanks: {} },
  }));
  const result = budgetTaskContext(items, undefined);
  assert.equal(result.budget.maxItems, 20);
  assert.equal(result.budget.maxEstimatedTokens, 4000);
});

test("validates opaque task context UUIDs", () => {
  const id = "550e8400-e29b-41d4-a716-446655440000";
  assert.equal(validateTaskContextId(id), id);
  for (const value of [undefined, "", "not-a-uuid", "550e8400-e29b-41d4-a716-44665544000g"]) {
    assert.throws(() => validateTaskContextId(value), /taskContextId/);
  }
});

test("models immutable lifecycle state and structured operation errors", () => {
  const lifecycle: TaskContextLifecycle = {
    taskContextId: "550e8400-e29b-41d4-a716-446655440000",
    repositoryIdentity: "repo",
    workspaceIdentity: "workspace",
    sessionId: "session",
    contextGeneration: "generation",
    task: "inspect",
    anchors: [{ kind: "file", path: "src/index.ts" }],
    taskIdentity: "task-v1:identity",
    defaultBudget: { maxItems: 20, maxEstimatedTokens: 4000 },
    latestPlanIdentity: "plan-v1:identity",
    ttlSeconds: 86_400,
    revision: 1,
    state: "active",
    createdAt: "2026-09-13T00:00:00.000Z",
    lastSeenAt: "2026-09-13T00:00:00.000Z",
    expiresAt: "2026-09-14T00:00:00.000Z",
    schemaVersion: 2,
  };
  assert.equal(typeof lifecycle.createdAt, "string");
  assert.equal(typeof lifecycle.lastSeenAt, "string");
  assert.equal(lifecycle.defaultBudget.maxItems, 20);
  assert.equal(lifecycle.latestPlanIdentity, "plan-v1:identity");

  const operationError = { code: "task_context_expired" as const, operation: "refresh" as const, message: "context expired", taskContextId: lifecycle.taskContextId, retryable: false, expectedRevision: 1, currentRevision: 1 };
  const error = new TaskContextLifecycleDomainError(operationError);
  assert.equal(error.name, "TaskContextLifecycleDomainError");
  assert.deepEqual(error.payload, operationError);
  assert.equal(error.operationError, error.payload);
});

test("error deliveries always carry an error payload", () => {
  const delivery: TaskContextDelivery = {
    subject: { kind: "file", path: "src/index.ts" },
    mode: "error",
    error: { code: "delivery_preparation_failed", message: "unable to deliver" },
  };
  assert.equal(delivery.error.code, "delivery_preparation_failed");
});
