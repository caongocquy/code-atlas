import assert from "node:assert/strict";
import test from "node:test";

import { createBudgetLedger } from "../src/core/graph/resolver/budgets.js";
import { createGenerationResolverContext } from "../src/core/graph/resolver/generation-context.js";
import { createResolverMemo } from "../src/core/graph/resolver/memo.js";
import type { IndexedSourceUnit } from "../src/core/indexing/indexing.types.js";
import { buildCodeGraphWithResolutionFromFacts, normalizeFacts } from "../src/core/graph/build-graph.js";
import type { LanguageSemanticAdapter, SemanticEvidenceBatch, SymbolIdentity } from "../src/core/graph/resolver/types.js";
import type { TypeEnvironment } from "../src/core/graph/resolver/type-environment.js";
import { makeFacts } from "./helpers/phase14b-facts.js";

const repositoryIdentity = { id: "repo", identityKey: "path-v1:repo", rootPath: "/repo", displayName: "repo" };
const sourceUnit = { repositoryId: "repo", relativePath: "consumer.ts", language: "typescript" } as const;
const symbol = (relativePath: string, kind: string, qualifiedName: string, discriminator: string): SymbolIdentity => ({
  repositoryId: "repo", relativePath, language: "typescript", kind, qualifiedName, discriminator,
});
const emptyEvidence = (): SemanticEvidenceBatch => ({
  bindings: [], imports: [], exports: [], typeAnnotations: [], constructors: [], assignments: [], parameters: [], returns: [], members: [], inheritance: [], implementations: [], aliases: [], modules: [], calls: [], diagnostics: [],
});

function context(adapter: LanguageSemanticAdapter, environment: TypeEnvironment) {
  return createGenerationResolverContext({
    generationId: "generation:1", repositoryIdentity, parsedFactsView: [], languageRegistry: [adapter], typeEnvironment: environment,
    budget: createBudgetLedger({ candidateExpansions: 100, bindingHops: 100, returnDepth: 100, inheritanceDepth: 100, memberCandidates: 100, expressionNodes: 100, propagationRounds: 100 }),
    memo: createResolverMemo(), resolutionVersion: "14b-2",
  });
}

function fixture(): { unit: IndexedSourceUnit; serviceUnit: IndexedSourceUnit; adapter: LanguageSemanticAdapter; environment: TypeEnvironment; adapterSourceUnit: () => unknown } {
  const run = symbol("consumer.ts", "function", "run", "symbol:run");
  const refresh = symbol("service.ts", "method", "Service.refresh", "symbol:refresh");
  const facts = makeFacts({
    symbols: [
      { localId: "symbol:run" as never, name: "run", kind: "function", range: { startLine: 1, endLine: 1 } },
      { localId: "symbol:refresh" as never, name: "refresh", kind: "method", range: { startLine: 1, endLine: 1 }, declaredQualifiedName: "Service.refresh" },
    ],
    callSites: [{ localId: "call:1" as never, calleeText: "refresh", callerId: "symbol:run" as never, range: { startLine: 1, endLine: 1 } }],
  });
  let adapterSourceUnit: unknown;
  const adapter: LanguageSemanticAdapter = {
    adapterId: "fixture", adapterVersion: 1, languages: ["typescript"], capabilities: () => Object.fromEntries([
      "moduleImport", "localBinding", "directCall", "declaredType", "constructorType", "receiverMember", "assignment", "parameterFlow", "returnFlow", "inheritance",
    ].map((key) => [key, "full"])) as never,
    normalizeFile: (_facts, input) => {
      adapterSourceUnit = input.sourceUnit;
      return {
        ...emptyEvidence(),
        bindings: [{ evidenceId: "binding:call" as never, sourceUnit: { ...sourceUnit, relativePath: "wrong.ts" }, range: { startLine: 1, endLine: 1 }, kind: "binding", scope: { sourceUnit: { ...sourceUnit, relativePath: "wrong.ts" }, localId: "scope:run" }, name: "refresh", bindingId: "call:1", declaredType: { kind: "known", symbol: refresh } }],
        calls: [{ evidenceId: "call:1" as never, sourceUnit: { ...sourceUnit, relativePath: "wrong.ts" }, range: { startLine: 1, endLine: 1 }, kind: "call", site: { sourceUnit: { ...sourceUnit, relativePath: "wrong.ts" }, localId: "call:1" }, calleeName: "refresh", receiver: { sourceUnit: { ...sourceUnit, relativePath: "wrong.ts" }, localId: "receiver:1" }, arguments: [{ sourceUnit: { ...sourceUnit, relativePath: "wrong.ts" }, localId: "argument:1" }] }],
      };
    },
  };
  const environment: TypeEnvironment = {
    lookupBinding: () => ({ status: "found", values: [{ evidenceId: "binding:call" as never, sourceUnit, range: { startLine: 1, endLine: 1 }, kind: "binding", scope: { sourceUnit, localId: "scope:run" }, name: "refresh", bindingId: "call:1", declaredType: { kind: "known", symbol: refresh } }], evidenceIds: ["binding:call"] as never }),
    inferType: () => ({ status: "unknown", reason: "insufficient_evidence", evidenceIds: [] }), resolveMember: () => ({ status: "unknown", reason: "insufficient_evidence", evidenceIds: [] }), resolveReturn: () => ({ status: "unknown", reason: "insufficient_evidence", evidenceIds: [] }), resolveInheritance: () => ({ status: "unknown", reason: "insufficient_evidence", evidenceIds: [] }), resolveImport: () => ({ status: "unknown", reason: "unresolved_import", evidenceIds: [] }),
  };
  const serviceFacts = makeFacts({ symbols: [{ localId: "symbol:refresh" as never, name: "refresh", kind: "method", range: { startLine: 1, endLine: 1 }, declaredQualifiedName: "Service.refresh" }] });
  return { unit: { relativePath: "consumer.ts", source: "must not be read", facts }, adapter, environment, serviceUnit: { relativePath: "service.ts", source: "must not be read", facts: serviceFacts }, adapterSourceUnit: () => adapterSourceUnit };
}

test("facts graph accepts only the strong semantic decision returned by the resolver", async () => {
  const { unit, adapter, environment, serviceUnit } = fixture();
  const result = await buildCodeGraphWithResolutionFromFacts("/repo", [unit, serviceUnit], undefined, "repo", ["consumer.ts"], context(adapter, environment));
  const decision = result.resolutionByFile.get("consumer.ts")?.decisions.find((item) => item.status === "resolved");
  assert.equal(decision?.status, "resolved");
  if (decision?.status === "resolved") assert.equal(decision.confidence, "strong");
  assert.equal(result.graph.edges.filter((edge) => edge.type === "calls").length, 1);
  assert.equal(result.resolutionByFile.get("consumer.ts")?.relativePath, "consumer.ts");
});

test("normalization repairs actual and nested source-unit identities", () => {
  const { unit, adapter, environment, adapterSourceUnit } = fixture();
  const normalized = normalizeFacts([{ facts: unit.facts, sourceUnit }], context(adapter, environment));
  assert.deepEqual(adapterSourceUnit(), sourceUnit);
  const batch = normalized[0];
  assert.deepEqual(batch?.bindings[0]?.sourceUnit, sourceUnit);
  assert.deepEqual(batch?.bindings[0]?.scope.sourceUnit, sourceUnit);
  assert.deepEqual(batch?.calls[0]?.sourceUnit, sourceUnit);
  assert.deepEqual(batch?.calls[0]?.site.sourceUnit, sourceUnit);
  assert.deepEqual(batch?.calls[0]?.receiver?.sourceUnit, sourceUnit);
  assert.deepEqual(batch?.calls[0]?.arguments[0]?.sourceUnit, sourceUnit);
});

test("facts graph canonicalizes permutations and deduplicates structural imports", async () => {
  const { unit, adapter, environment, serviceUnit } = fixture();
  const duplicated = { ...unit, facts: makeFacts({ ...unit.facts, imports: [
    { localId: "import:1" as never, moduleSpecifier: "./service.js", kind: "named", range: { startLine: 1, endLine: 1 } },
    { localId: "import:2" as never, moduleSpecifier: "./service.js", kind: "named", range: { startLine: 1, endLine: 1 } },
  ] }) };
  const first = await buildCodeGraphWithResolutionFromFacts("/repo", [duplicated, serviceUnit], undefined, "repo", ["consumer.ts"], context(adapter, environment));
  const second = await buildCodeGraphWithResolutionFromFacts("/repo", [serviceUnit, duplicated], undefined, "repo", ["consumer.ts"], context(adapter, environment));
  assert.deepEqual(first.graph, second.graph);
  assert.equal(first.graph.edges.filter((edge) => edge.type === "imports").length, 1);
});
