import assert from "node:assert/strict";
import test from "node:test";

import { budgetTaskContext } from "../src/core/context/task-context-budget.js";
import { rankTaskContextCandidates } from "../src/core/context/task-context-ranker.js";
import type { TaskContextCandidate } from "../src/core/context/task-context.types.js";

function item(priorityEvidence: TaskContextCandidate["evidence"], exact = true): TaskContextCandidate {
  return { subject: { kind: "file", path: `${priorityEvidence[0]!.kind}.ts` }, evidence: priorityEvidence, sourceRanks: {}, exact, estimatedTokens: 10 };
}

test("selects required before optional and reports omitted items", () => {
  const items = rankTaskContextCandidates([
    item([{ kind: "explicit_changed_path", path: "required.ts" }]),
    item([{ kind: "lexical", rank: 1, query: "optional" }]),
  ]);
  const result = budgetTaskContext(items, { maxItems: 1, maxEstimatedTokens: 100 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.priority, "required");
  assert.equal(result.budget.omittedItems, 1);
});

test("exact-addressable retrieval remains budgeted", () => {
  const items = rankTaskContextCandidates([
    item([{ kind: "explicit_anchor", anchor: { kind: "file", path: "required.ts" } }]),
    item([{ kind: "lexical", rank: 1, query: "fuzzy" }], true),
  ]);
  const result = budgetTaskContext(items, { maxItems: 1 });
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]!.priority, "required");
  assert.equal(result.budget.omittedItems, 1);
});
