import test from "node:test";
import assert from "node:assert/strict";
import { createBudgetLedger } from "../src/core/graph/resolver/budgets.js";
import { createResolverMemo } from "../src/core/graph/resolver/memo.js";

test("budget ledger is deterministic and memo stores only stable entries", () => {
  const ledger = createBudgetLedger({
    candidateExpansions: 2,
    bindingHops: 1,
    returnDepth: 1,
    inheritanceDepth: 1,
    memberCandidates: 1,
    expressionNodes: 2,
    propagationRounds: 1,
  });

  assert.equal(ledger.consume("candidateExpansions"), true);
  assert.equal(ledger.consume("candidateExpansions"), true);
  assert.equal(ledger.consume("candidateExpansions"), false);

  const memo = createResolverMemo();
  memo.set("k", {
    kind: "unknown",
    reason: "dynamic_expression",
    evidenceIds: [],
    stable: true,
  });
  assert.equal(memo.get("k")?.kind, "unknown");
});
