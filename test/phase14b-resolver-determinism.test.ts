import assert from "node:assert/strict";
import test from "node:test";

import { createBudgetLedger } from "../src/core/graph/resolver/budgets.js";
import { createResolverMemo } from "../src/core/graph/resolver/memo.js";
import { createGenerationResolverContext } from "../src/core/graph/resolver/generation-context.js";
import { ORDERED_STRATEGIES } from "../src/core/graph/resolver/strategies.js";
import { resolveSite } from "../src/core/graph/resolver/resolver.js";
import type { ParsedFactsBlob } from "../src/core/facts/facts.types.js";
import type { SemanticEvidenceBatch, ResolutionSiteIdentity } from "../src/core/graph/resolver/types.js";

const sourceUnit = { repositoryId: "repo", relativePath: "src/app.ts", language: "typescript" } as const;
const site: ResolutionSiteIdentity = { sourceUnit, localId: "missing" };
const facts = {} as ParsedFactsBlob;
const evidence: SemanticEvidenceBatch = {
  bindings: [], imports: [], exports: [], typeAnnotations: [], constructors: [], assignments: [], parameters: [], returns: [], members: [], inheritance: [], implementations: [], aliases: [], modules: [], calls: [], diagnostics: [],
};
const budgets = () => ({ candidateExpansions: 0, bindingHops: 10, returnDepth: 10, inheritanceDepth: 10, memberCandidates: 10, expressionNodes: 10, propagationRounds: 10 });
const resolveFixture = (memo: ReturnType<typeof createResolverMemo>) => {
  const context = createGenerationResolverContext({
    generationId: "generation:1",
    repositoryIdentity: { id: "repo", identityKey: "path-v1:repo", rootPath: "/repo", displayName: "repo" },
    parsedFactsView: [facts], languageRegistry: [], typeEnvironment: {} as never,
    budget: createBudgetLedger(budgets()), memo, resolutionVersion: "14b-2",
  });
  return resolveSite({ facts, evidence, environment: context.typeEnvironment, context }, site);
};

test("resolver uses the fixed strategy order exactly once", () => {
  assert.deepEqual(ORDERED_STRATEGIES, [
    "lexical-local", "imports-exports", "explicit-type", "constructor", "assignment", "parameter",
    "return", "alias", "inheritance", "receiver-member", "chained-call", "bounded-interprocedural",
  ]);
  const decision = resolveFixture(createResolverMemo());
  assert.deepEqual(decision.attemptedStrategies, ORDERED_STRATEGIES);
});

test("budget exhaustion and warm memoization preserve deterministic semantics", () => {
  const cold = resolveFixture(createResolverMemo());
  const warmMemo = createResolverMemo();
  const warmFirst = resolveFixture(warmMemo);
  const warmSecond = resolveFixture(warmMemo);
  assert.equal(cold.status, "budget_exhausted");
  assert.deepEqual(warmFirst, warmSecond);
});
