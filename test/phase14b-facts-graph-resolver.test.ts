import assert from "node:assert/strict";
import test from "node:test";

import { createBudgetLedger } from "../src/core/graph/resolver/budgets.js";
import { createGenerationResolverContext } from "../src/core/graph/resolver/generation-context.js";
import { createResolverMemo } from "../src/core/graph/resolver/memo.js";
import type { IndexedSourceUnit } from "../src/core/indexing/indexing.types.js";
import { buildCodeGraphWithResolutionFromFacts } from "../src/core/graph/build-graph.js";
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

function fixture(): { unit: IndexedSourceUnit; adapter: LanguageSemanticAdapter; environment: TypeEnvironment } {
  const run = symbol("consumer.ts", "function", "run", "symbol:run");
  const refresh = symbol("service.ts", "method", "Service.refresh", "symbol:refresh");
  const facts = makeFacts({
    symbols: [
      { localId: "symbol:run" as never, name: "run", kind: "function", range: { startLine: 1, endLine: 1 } },
      { localId: "symbol:refresh" as never, name: "refresh", kind: "method", range: { startLine: 1, endLine: 1 }, declaredQualifiedName: "Service.refresh" },
    ],
    callSites: [{ localId: "call:1" as never, calleeText: "refresh", callerId: "symbol:run" as never, range: { startLine: 1, endLine: 1 } }],
  });
  const adapter: LanguageSemanticAdapter = {
    adapterId: "fixture", adapterVersion: 1, languages: ["typescript"], capabilities: () => Object.fromEntries([
      "moduleImport", "localBinding", "directCall", "declaredType", "constructorType", "receiverMember", "assignment", "parameterFlow", "returnFlow", "inheritance",
    ].map((key) => [key, "full"])) as never,
    normalizeFile: () => ({
      ...emptyEvidence(),
      bindings: [{ evidenceId: "binding:call" as never, sourceUnit, range: { startLine: 1, endLine: 1 }, kind: "binding", scope: { sourceUnit, localId: "scope:run" }, name: "refresh", bindingId: "call:1", declaredType: { kind: "known", symbol: refresh } }],
      calls: [{ evidenceId: "call:1" as never, sourceUnit, range: { startLine: 1, endLine: 1 }, kind: "call", site: { sourceUnit, localId: "call:1" }, calleeName: "refresh", arguments: [] }],
    }),
  };
  const environment: TypeEnvironment = {
    lookupBinding: () => ({ status: "found", values: [{ evidenceId: "binding:call" as never, sourceUnit, range: { startLine: 1, endLine: 1 }, kind: "binding", scope: { sourceUnit, localId: "scope:run" }, name: "refresh", bindingId: "call:1", declaredType: { kind: "known", symbol: refresh } }], evidenceIds: ["binding:call"] as never }),
    inferType: () => ({ status: "unknown", reason: "insufficient_evidence", evidenceIds: [] }), resolveMember: () => ({ status: "unknown", reason: "insufficient_evidence", evidenceIds: [] }), resolveReturn: () => ({ status: "unknown", reason: "insufficient_evidence", evidenceIds: [] }), resolveInheritance: () => ({ status: "unknown", reason: "insufficient_evidence", evidenceIds: [] }), resolveImport: () => ({ status: "unknown", reason: "unresolved_import", evidenceIds: [] }),
  };
  const serviceFacts = makeFacts({ symbols: [{ localId: "symbol:refresh" as never, name: "refresh", kind: "method", range: { startLine: 1, endLine: 1 }, declaredQualifiedName: "Service.refresh" }] });
  return { unit: { relativePath: "consumer.ts", source: "must not be read", facts }, adapter, environment, serviceUnit: { relativePath: "service.ts", source: "must not be read", facts: serviceFacts } } as never;
}

test("facts graph accepts only the strong semantic decision returned by the resolver", async () => {
  const { unit, adapter, environment, serviceUnit } = fixture() as ReturnType<typeof fixture> & { serviceUnit: IndexedSourceUnit };
  const result = await buildCodeGraphWithResolutionFromFacts("/repo", [unit, serviceUnit], undefined, "repo", ["consumer.ts"], context(adapter, environment));
  const decision = result.resolutionByFile.get("consumer.ts")?.decisions.find((item) => item.status === "resolved");
  assert.equal(decision?.status, "resolved");
  if (decision?.status === "resolved") assert.equal(decision.confidence, "strong");
  assert.equal(result.graph.edges.filter((edge) => edge.type === "calls").length, 1);
});
