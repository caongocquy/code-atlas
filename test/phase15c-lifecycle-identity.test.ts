import assert from "node:assert/strict";
import test from "node:test";

import { budgetTaskContext, DEFAULT_TASK_CONTEXT_BUDGET } from "../src/core/context/task-context-budget.js";
import { createTaskIntentIdentity, normalizeLifecycleBudget, normalizeLifecycleTtlSeconds } from "../src/core/context/task-context-lifecycle-identity.js";
import { normalizeTaskContextInput } from "../src/core/context/task-context-normalizer.js";
import type { TaskContextCandidate } from "../src/core/context/task-context.types.js";

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

  const candidates = Array.from({ length: 21 }, (_, index): TaskContextCandidate => ({
    subject: { kind: "file", path: `src/${index}.ts` },
    evidence: [],
    sourceRanks: {},
    exact: false,
  }));
  const result = budgetTaskContext(candidates.map((candidate) => ({ ...candidate, priority: "optional" as const, rank: 1, reasons: [], scoreSignal: 0, fusion: { sourceRanks: {} } })), undefined);
  assert.equal(result.budget.maxItems, 20);
  assert.equal(result.budget.maxEstimatedTokens, 4000);
});
