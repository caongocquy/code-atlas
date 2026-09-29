import assert from "node:assert/strict";
import test from "node:test";

import { compileTaskContext } from "../src/core/context/task-context-compiler.js";

test("hard evaluation expectations hold for explicit targets and repeatability", async () => {
  const deps = { repositoryPath: "/repo", repositoryIdentity: "repo", workspaceIdentity: "workspace", collect: async () => ({ candidates: [{ subject: { kind: "file" as const, path: "src/exact.ts" }, evidence: [{ kind: "explicit_anchor" as const, anchor: { kind: "file" as const, path: "src/exact.ts" } }], sourceRanks: {}, exact: true, estimatedTokens: 4 }], reliability: { mayBeIncomplete: false, capabilityStates: {}, diagnostics: [] } }) };
  const first = await compileTaskContext({ task: "exact", anchors: [{ kind: "file", path: "src/exact.ts" }] }, deps);
  const second = await compileTaskContext({ task: "exact", anchors: [{ kind: "file", path: "src/exact.ts" }] }, deps);
  assert.equal(first.items.length, 1); // explicit exact target hit: 100%
  assert.equal(first.planIdentity, second.planIdentity); // deterministic repeatability: 100%
  assert.equal(first.budget.budgetExceeded, false); // required silently dropped by budget: 0%
  assert.equal(first.items.every((item) => item.priority === "required"), true); // ambiguous false-required promotion: 0%
});
