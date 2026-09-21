import assert from "node:assert/strict";
import test from "node:test";

import { createBudgetLedger } from "../src/core/graph/resolver/budgets.js";
import { createResolverMemo } from "../src/core/graph/resolver/memo.js";
import { createGenerationResolverContext } from "../src/core/graph/resolver/generation-context.js";
import { ORDERED_STRATEGIES } from "../src/core/graph/resolver/strategies.js";
import { resolveSite } from "../src/core/graph/resolver/resolver.js";
import { resolveStrategy } from "../src/core/graph/resolver/strategies.js";
import type { ParsedFactsBlob } from "../src/core/facts/facts.types.js";
import type { BindingEvidence, LanguageSemanticAdapter, ResolutionSiteIdentity, ReturnEvidence, SemanticEvidenceBatch, SymbolIdentity, TypeRef } from "../src/core/graph/resolver/types.js";
import type { LookupResult, TypeEnvironment } from "../src/core/graph/resolver/type-environment.js";

const sourceUnit = { repositoryId: "repo", relativePath: "src/app.ts", language: "typescript" } as const;
const site: ResolutionSiteIdentity = { sourceUnit, localId: "site:fixture" };
const facts = {} as ParsedFactsBlob;
const evidence: SemanticEvidenceBatch = {
  bindings: [], imports: [], exports: [], typeAnnotations: [], constructors: [], assignments: [], parameters: [], returns: [], members: [], inheritance: [], implementations: [], aliases: [], modules: [], calls: [], diagnostics: [],
};
const makeFacts = (language = "typescript"): ParsedFactsBlob => ({
  factsSchemaVersion: "1", factsVersion: "1", contentHash: "hash", language: language as never,
  parserIdentity: { language: language as never, runtimeName: "tree-sitter", runtimeVersion: "1", packageName: "parser", grammarName: language, grammarVersion: "1" },
  parseStatus: "complete", parserDiagnostics: [], symbols: [], containmentScopes: [], imports: [], exports: [], references: [], callSites: [], bindingSeeds: [], declaredTypeAnnotations: [], expressions: [], members: [], assignments: [], parameters: [], returns: [], constructors: [], inheritances: [], implementations: [], aliases: [], modules: [], namespaces: [],
});
const source = { repositoryId: "repo", relativePath: "src/app.ts", language: "typescript" } as const;
const otherSource = { repositoryId: "other", relativePath: "src/app.ts", language: "typescript" } as const;
const target = (name: string, sourceUnit = source): SymbolIdentity => ({ repositoryId: sourceUnit.repositoryId, relativePath: sourceUnit.relativePath, language: sourceUnit.language, kind: "class", qualifiedName: name, discriminator: name });
const environment = (lookup: (scope: BindingEvidence["scope"], name: string) => LookupResult<BindingEvidence>): TypeEnvironment => ({
  lookupBinding: lookup,
  inferType: () => ({ status: "unknown", reason: "insufficient_evidence", evidenceIds: [] }),
  resolveMember: () => ({ status: "unknown", reason: "insufficient_evidence", evidenceIds: [] }),
  resolveReturn: () => ({ status: "unknown", reason: "insufficient_evidence", evidenceIds: [] }),
  resolveInheritance: () => ({ status: "unknown", reason: "insufficient_evidence", evidenceIds: [] }),
  resolveImport: () => ({ status: "unknown", reason: "unresolved_import", evidenceIds: [] }),
});
const baseContext = (options: { memo?: ReturnType<typeof createResolverMemo>; budget?: ReturnType<typeof budgets>; adapter?: LanguageSemanticAdapter; typeEnvironment?: TypeEnvironment } = {}) => createGenerationResolverContext({
  generationId: "generation:1", repositoryIdentity: { id: "repo", identityKey: "path-v1:repo", rootPath: "/repo", displayName: "repo" }, parsedFactsView: [], languageRegistry: options.adapter ? [options.adapter] : [], typeEnvironment: options.typeEnvironment ?? environment(() => ({ status: "unknown", reason: "insufficient_evidence", evidenceIds: [] })), budget: createBudgetLedger(options.budget ?? { candidateExpansions: 10, bindingHops: 10, returnDepth: 10, inheritanceDepth: 10, memberCandidates: 10, expressionNodes: 10, propagationRounds: 10 }), memo: options.memo ?? createResolverMemo(), resolutionVersion: "14b-2",
});
const budgets = () => ({ candidateExpansions: 1, bindingHops: 10, returnDepth: 10, inheritanceDepth: 10, memberCandidates: 10, expressionNodes: 10, propagationRounds: 10 });
const fixtureBinding: BindingEvidence = {
  evidenceId: "binding:fixture" as never, sourceUnit, range: { startLine: 1, endLine: 1 }, kind: "binding", scope: { sourceUnit, localId: "scope:1" }, name: "service", bindingId: "site:fixture", declaredType: { kind: "known", symbol: target("Fixture") },
};
const resolveFixture = (memo: ReturnType<typeof createResolverMemo>) => {
  const fixtureFacts = makeFacts();
  const typeEnvironment = environment(() => ({ status: "found", values: [fixtureBinding], evidenceIds: [fixtureBinding.evidenceId] }));
  const context = createGenerationResolverContext({
    generationId: "generation:1",
    repositoryIdentity: { id: "repo", identityKey: "path-v1:repo", rootPath: "/repo", displayName: "repo" },
    parsedFactsView: [fixtureFacts], languageRegistry: [], typeEnvironment,
    budget: createBudgetLedger(budgets()), memo, resolutionVersion: "14b-2",
  });
  return resolveSite({ facts: fixtureFacts, evidence: { ...evidence, bindings: [fixtureBinding] }, environment: typeEnvironment, context }, site);
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
  const coldMemo = createResolverMemo();
  const cold = resolveFixture(coldMemo);
  assert.equal(cold.status, "resolved");
  assert.equal(coldMemo.size(), 1);
  const warmMemo = createResolverMemo();
  const warmFirst = resolveFixture(warmMemo);
  const warmSecond = resolveFixture(warmMemo);
  assert.equal(warmFirst.status, "resolved");
  assert.deepEqual(warmFirst, warmSecond);
  assert.equal(warmMemo.size(), 1);
});

test("strategies query the injected environment only for the requested source unit and site", () => {
  const binding: BindingEvidence = {
    evidenceId: "binding:current" as never, sourceUnit: source, range: { startLine: 1, endLine: 1 }, kind: "binding", scope: { sourceUnit: source, localId: "scope:1" }, name: "service", bindingId: "site:1", declaredType: { kind: "known", symbol: target("Current") },
  };
  const other: BindingEvidence = { ...binding, evidenceId: "binding:other" as never, sourceUnit: otherSource, scope: { sourceUnit: otherSource, localId: "scope:1" }, declaredType: { kind: "known", symbol: target("Other", otherSource) } };
  let calls = 0;
  const typeEnvironment = environment((scope, name) => {
    calls += 1;
    assert.equal(scope.sourceUnit, source);
    assert.equal(name, "service");
    return { status: "found", values: [binding], evidenceIds: [binding.evidenceId] };
  });
  const context = baseContext({ typeEnvironment });
  const input = { facts: makeFacts(), evidence: { ...evidence, bindings: [binding, other] }, environment: typeEnvironment, context };
  const result = resolveStrategy(input, { sourceUnit: source, localId: "site:1" }, "lexical-local");
  assert.deepEqual(result.map((item) => item.target.qualifiedName), ["Current"]);
  assert.equal(calls, 1);
});

test("registered adapters with missing required capability produce unsupported", () => {
  const unsupported = Object.fromEntries([
    "moduleImport", "localBinding", "directCall", "declaredType", "constructorType", "receiverMember", "assignment", "parameterFlow", "returnFlow", "inheritance",
  ].map((key) => [key, "unsupported"]));
  const adapter: LanguageSemanticAdapter = { adapterId: "typescript", adapterVersion: 1, languages: ["typescript"], capabilities: () => unsupported as never, normalizeFile: () => evidence };
  const context = baseContext({ adapter });
  const input = { facts: makeFacts(), evidence, environment: context.typeEnvironment, context };
  const decision = resolveSite(input, site);
  assert.equal(decision.status, "unsupported");
});

test("warm memo resolution is equivalent and avoids a second environment lookup", () => {
  const memo = createResolverMemo();
  const warmSite: ResolutionSiteIdentity = { sourceUnit: source, localId: "site:1" };
  const binding: BindingEvidence = {
    evidenceId: "binding:warm" as never, sourceUnit: source, range: { startLine: 1, endLine: 1 }, kind: "binding", scope: { sourceUnit: source, localId: "scope:1" }, name: "service", bindingId: "site:1", declaredType: { kind: "known", symbol: target("Warm") },
  };
  let coldCalls = 0;
  const coldEnvironment = environment(() => { coldCalls += 1; return { status: "found", values: [binding], evidenceIds: [binding.evidenceId] }; });
  const coldContext = baseContext({ memo, typeEnvironment: coldEnvironment });
  const cold = resolveStrategy({ facts: makeFacts(), evidence: { ...evidence, bindings: [binding] }, environment: coldEnvironment, context: coldContext }, warmSite, "lexical-local");
  assert.equal(cold.length, 1);
  assert.equal(coldCalls, 1);

  const warmEnvironment = environment(() => { throw new Error("warm lookup should use memo"); });
  const warmContext = baseContext({ memo, typeEnvironment: warmEnvironment, budget: budgets() });
  const warm = resolveStrategy({ facts: makeFacts(), evidence: { ...evidence, bindings: [binding] }, environment: warmEnvironment, context: warmContext }, warmSite, "lexical-local");
  assert.deepEqual(warm, cold);
});

test("return strategy resolves through the injected resolveReturn API for the callable identity", () => {
  const callable = target("Service.run");
  const returnEvidence: ReturnEvidence = {
    evidenceId: "return:site" as never, sourceUnit, range: { startLine: 1, endLine: 1 }, kind: "return", callable,
  };
  const returnFact = { localId: "return:1", ownerSymbolId: callable.discriminator, expressionId: undefined, typeText: undefined, range: { startLine: 1, endLine: 1 } } as never;
  const returnType: TypeRef = { kind: "known", symbol: target("Result") };
  let resolvedCallable: SymbolIdentity | undefined;
  const typeEnvironment = environment(() => ({ status: "unknown", reason: "insufficient_evidence", evidenceIds: [] }));
  typeEnvironment.resolveReturn = (candidate) => {
    resolvedCallable = candidate;
    return { status: "found", values: [returnType], evidenceIds: [returnEvidence.evidenceId] };
  };
  const context = baseContext({ typeEnvironment });
  const returnSite: ResolutionSiteIdentity = { sourceUnit, localId: "return:1" };
  const returnInput = { facts: { ...makeFacts(), returns: [returnFact] }, evidence: { ...evidence, returns: [returnEvidence] }, environment: typeEnvironment, context };
  const result = resolveStrategy(returnInput, returnSite, "return");
  assert.deepEqual(result.map((candidate) => candidate.target.qualifiedName), ["Result"]);
  assert.deepEqual(resolvedCallable, callable);
});
