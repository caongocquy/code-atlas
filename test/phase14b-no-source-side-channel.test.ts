import assert from "node:assert/strict";
import test from "node:test";

import { createBudgetLedger } from "../src/core/graph/resolver/budgets.js";
import { createGenerationResolverContext } from "../src/core/graph/resolver/generation-context.js";
import { createResolverMemo } from "../src/core/graph/resolver/memo.js";
import { buildCodeGraphWithResolutionFromFacts } from "../src/core/graph/build-graph.js";
import type { IndexedSourceUnit } from "../src/core/indexing/indexing.types.js";
import type { LanguageSemanticAdapter } from "../src/core/graph/resolver/types.js";
import type { TypeEnvironment } from "../src/core/graph/resolver/type-environment.js";
import { makeFacts } from "./helpers/phase14b-facts.js";

test("facts graph construction does not invoke semantic source-text fallback", async () => {
  let semanticSourceFallbackCalls = 0;
  const unit = { relativePath: "unsupported.go", get source(): string { semanticSourceFallbackCalls += 1; throw new Error("source fallback"); }, facts: makeFacts({ language: "typescript" }) } as IndexedSourceUnit;
  const environment = {} as TypeEnvironment;
  const context = createGenerationResolverContext({ generationId: "generation:1", repositoryIdentity: { id: "repo", identityKey: "path-v1:repo", rootPath: "/repo", displayName: "repo" }, parsedFactsView: [], languageRegistry: [], typeEnvironment: environment, budget: createBudgetLedger({ candidateExpansions: 10, bindingHops: 10, returnDepth: 10, inheritanceDepth: 10, memberCandidates: 10, expressionNodes: 10, propagationRounds: 10 }), memo: createResolverMemo(), resolutionVersion: "14b-2" });
  await buildCodeGraphWithResolutionFromFacts("/repo", [unit], undefined, "repo", undefined, context);
  assert.equal(semanticSourceFallbackCalls, 0);
});

test("missing facts adapter records an explicit unsupported trace", async () => {
  const facts = makeFacts({ callSites: [{ localId: "call:1" as never, calleeText: "run", range: { startLine: 1, endLine: 1 } }] });
  const unit = { relativePath: "unknown.ts", source: "unused", facts } as IndexedSourceUnit;
  const context = createGenerationResolverContext({ generationId: "generation:1", repositoryIdentity: { id: "repo", identityKey: "path-v1:repo", rootPath: "/repo", displayName: "repo" }, parsedFactsView: [], languageRegistry: [], typeEnvironment: {} as TypeEnvironment, budget: createBudgetLedger({ candidateExpansions: 10, bindingHops: 10, returnDepth: 10, inheritanceDepth: 10, memberCandidates: 10, expressionNodes: 10, propagationRounds: 10 }), memo: createResolverMemo(), resolutionVersion: "14b-2" });
  const result = await buildCodeGraphWithResolutionFromFacts("/repo", [unit], undefined, "repo", undefined, context);
  assert.equal(result.resolutionByFile.get("unknown.ts")?.decisions[0]?.status, "unsupported");
  assert.equal(result.resolutionByFile.get("unknown.ts")?.trace[0]?.status, "unsupported");
});
