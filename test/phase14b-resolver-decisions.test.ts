import assert from "node:assert/strict";
import test from "node:test";

import { createBudgetLedger } from "../src/core/graph/resolver/budgets.js";
import { createResolverMemo } from "../src/core/graph/resolver/memo.js";
import { createGenerationResolverContext } from "../src/core/graph/resolver/generation-context.js";
import { uniqueTargetGate } from "../src/core/graph/resolver/decision.js";
import type { ParsedFactsBlob } from "../src/core/facts/facts.types.js";
import type {
  LanguageSemanticAdapter,
  ResolutionSiteIdentity,
  SemanticEvidenceBatch,
  SymbolIdentity,
} from "../src/core/graph/resolver/types.js";
import type { ResolutionCandidate, ResolverInput } from "../src/core/graph/resolver/decision.js";

const sourceUnit = { repositoryId: "repo", relativePath: "src/app.ts", language: "typescript" } as const;
const site: ResolutionSiteIdentity = { sourceUnit, localId: "call:1" };
const symbol = (qualifiedName: string): SymbolIdentity => ({
  repositoryId: "repo", relativePath: "src/app.ts", language: "typescript", kind: "function", qualifiedName, discriminator: qualifiedName,
});
const candidate = (name: string, confidence: ResolutionCandidate["confidence"]): ResolutionCandidate => ({
  target: symbol(name), strategy: "lexical-local", confidence, evidenceIds: [`evidence:${name}` as never],
});
const emptyEvidence: SemanticEvidenceBatch = {
  bindings: [], imports: [], exports: [], typeAnnotations: [], constructors: [], assignments: [], parameters: [], returns: [], members: [], inheritance: [], implementations: [], aliases: [], modules: [], calls: [], diagnostics: [],
};
const facts = {} as ParsedFactsBlob;
const adapter = {} as LanguageSemanticAdapter;
const input = (budget = 10): ResolverInput => {
  const context = createGenerationResolverContext({
    generationId: "generation:1",
    repositoryIdentity: { id: "repo", identityKey: "path-v1:repo", rootPath: "/repo", displayName: "repo" },
    parsedFactsView: [facts], languageRegistry: [adapter], typeEnvironment: {} as never,
    budget: createBudgetLedger({ candidateExpansions: budget, bindingHops: 10, returnDepth: 10, inheritanceDepth: 10, memberCandidates: 10, expressionNodes: 10, propagationRounds: 10 }),
    memo: createResolverMemo(), resolutionVersion: "14b-2",
  });
  return { facts, evidence: emptyEvidence, environment: context.typeEnvironment, context };
};

test("unique gate accepts strong single target and drops weak or ambiguous candidates", () => {
  assert.equal(uniqueTargetGate(input(), site, [candidate("target", "strong")], ["lexical-local"]).status, "resolved");
  assert.equal(uniqueTargetGate(input(), site, [candidate("a", "strong"), candidate("b", "strong")], ["lexical-local"]).status, "ambiguous");
  const weak = uniqueTargetGate(input(), site, [candidate("target", "weak")], ["lexical-local"]);
  assert.equal(weak.status, "unknown");
  if (weak.status === "unknown") assert.equal(weak.reason, "weak_only");
});

test("gate preserves explicit budget exhaustion and trace collection is in-memory", () => {
  const resolverInput = input(0);
  assert.equal(resolverInput.context.budget.consume("candidateExpansions"), false);
  const decision = uniqueTargetGate(resolverInput, site, [], ["lexical-local"]);
  assert.equal(decision.status, "budget_exhausted");
  const events = resolverInput.context.diagnostics;
  events.add({ site, status: "unknown", reason: "weak_only" });
  assert.deepEqual(events.snapshot().map(({ status, reason }) => ({ status, reason })), [
    { status: "budget_exhausted", reason: "candidate_expansion_limit" },
    { status: "unknown", reason: "weak_only" },
  ]);
});

test("same target merges all supporting evidence IDs in canonical order", () => {
  const target = candidate("target", "strong");
  const duplicate = { ...target, evidenceIds: ["evidence:z", "evidence:a"] as never };
  const decision = uniqueTargetGate(input(), site, [target, duplicate], ["lexical-local"]);
  assert.equal(decision.status, "resolved");
  assert.deepEqual(decision.evidenceIds, ["evidence:a", "evidence:target", "evidence:z"]);
});
