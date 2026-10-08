import assert from "node:assert/strict";
import test from "node:test";
import { createTypeEnvironment } from "../src/core/graph/resolver/type-environment.js";
import { createBudgetLedger } from "../src/core/graph/resolver/budgets.js";
import { createResolverMemo } from "../src/core/graph/resolver/memo.js";

test("repeated inference reuses only its root memo and cannot bypass another root budget", () => {
  const limits = { candidateExpansions: 1000, bindingHops: 1000, returnDepth: 1000, inheritanceDepth: 1000, memberCandidates: 1000, expressionNodes: 1, propagationRounds: 1000 };
  const generationBudget = createBudgetLedger(limits), generationMemo = createResolverMemo();
  const environment = createTypeEnvironment({ generationId: "generation", symbols: [], evidence: [], budget: generationBudget, memo: generationMemo });
  const aBudget = generationBudget.fork(), aMemo = createResolverMemo(), a = environment.fork!(aBudget, aMemo);
  const expression = { sourceUnit: { repositoryId: "repo", relativePath: "a.ts", language: "typescript" as const }, localId: "expression:0" };
  const first = a.inferType(expression);
  assert.equal(first.status, "unknown");
  assert.equal(aMemo.size(), 1);
  assert.equal(aBudget.remaining("expressionNodes"), 0);
  assert.deepEqual(a.inferType(expression), first);
  assert.equal(aBudget.failed("expressionNodes"), false);
  const bBudget = createBudgetLedger({ ...limits, expressionNodes: 0 }), bMemo = createResolverMemo();
  const b = environment.fork!(bBudget, bMemo);
  assert.equal(b.inferType(expression).status, "budget_exhausted");
  assert.equal(bMemo.size(), 0);
  assert.equal(aBudget.failed("expressionNodes"), false);
  assert.equal(generationMemo.size(), 0);
  assert.equal(generationBudget.remaining("expressionNodes"), 1);
  const cold = environment.fork!(generationBudget.fork(), createResolverMemo());
  assert.deepEqual(cold.inferType(expression), first);
});
