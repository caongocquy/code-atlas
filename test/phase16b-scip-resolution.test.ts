import assert from "node:assert/strict";
import test from "node:test";

import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { uniqueTargetGate, type ResolutionCandidate, type ResolverInput } from "../src/core/graph/resolver/decision.js";
import { buildPipelineResolverContext } from "../src/core/indexing/index-pipeline.service.js";
import { scipBindingKey, type ScipBindingEvidence } from "../src/core/graph/resolver/scip-evidence.js";
import { semanticAdapters } from "../src/core/graph/resolver/adapter-registry.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import type { SemanticEvidenceBatch } from "../src/core/graph/resolver/types.js";

const emptyEvidence: SemanticEvidenceBatch = {
  bindings: [], imports: [], exports: [], typeAnnotations: [], constructors: [], assignments: [],
  parameters: [], returns: [], members: [], inheritance: [], implementations: [], aliases: [],
  modules: [], calls: [], diagnostics: [],
};

function fixture() {
  const facts = extractParsedFacts({
    source: "export function caller() { return external(); }\n",
    language: "typescript",
    filePath: "caller.ts",
    repositoryId: "repo-id",
    contentHash: "source-hash",
  });
  assert.equal(facts.kind, "facts");
  const symbol = {
    repositoryId: "repo-id",
    relativePath: "target.ts",
    language: "typescript" as const,
    kind: "function",
    qualifiedName: "target",
    discriminator: "symbol:target",
  };
  const call = facts.facts.callSites.find((item) => item.calleeText === "external");
  assert.ok(call);
  const binding: ScipBindingEvidence = {
    sourceUnit: { repositoryId: "repo-id", relativePath: "caller.ts", language: "typescript" },
    siteLocalId: call.localId,
    target: symbol,
    evidenceId: "scip:abc",
    range: { startLine: 1, endLine: 1, startColumn: 34, endColumn: 42 },
  };
  const context = buildPipelineResolverContext({
    generationId: "generation",
    repositoryIdentity: getRepositoryIdentity("/tmp/code-atlas-phase16b-fixture"),
    facts: [facts.facts],
    adapters: semanticAdapters,
    resolutionVersion: "resolution-1",
    relativePaths: ["caller.ts"],
    scipEvidenceBySite: new Map([[scipBindingKey(binding.sourceUnit, binding.siteLocalId), [binding]]]),
  });
  const input: ResolverInput = { facts: facts.facts, evidence: emptyEvidence, environment: context.typeEnvironment, context };
  const site = { sourceUnit: binding.sourceUnit, localId: binding.siteLocalId };
  return { input, site, binding, symbol };
}

test("the resolver consumes normalized SCIP target evidence as an exact candidate", async () => {
  const { input, site, binding, symbol } = fixture();
  const { resolveSite } = await import("../src/core/graph/resolver/resolver.js");
  const decision = resolveSite(input, site);

  assert.equal(decision.status, "resolved");
  if (decision.status !== "resolved") return;
  assert.deepEqual(decision.target, symbol);
  assert.equal(decision.strategy, "scip");
  assert.equal(decision.confidence, "exact");
  assert.ok(decision.evidenceIds.includes(binding.evidenceId));
  assert.equal(decision.attemptedStrategies[0], "scip");
  assert.deepEqual(decision.attemptedStrategies.slice(1), [
    "lexical-local", "imports-exports", "explicit-type", "constructor", "assignment", "parameter",
    "return", "alias", "inheritance", "receiver-member", "chained-call", "bounded-interprocedural",
  ]);
});

test("Resolution v2 merges identical parser and SCIP targets but drops conflicting targets", () => {
  const { input, site, symbol } = fixture();
  const parserCandidate: ResolutionCandidate = {
    target: symbol,
    strategy: "imports-exports",
    confidence: "strong",
    evidenceIds: ["parser:import" as never],
  };
  const scipCandidate: ResolutionCandidate = {
    target: symbol,
    strategy: "scip",
    confidence: "exact",
    evidenceIds: ["scip:abc" as never],
  };

  const merged = uniqueTargetGate(input, site, [parserCandidate, scipCandidate], ["scip", "imports-exports"]);
  assert.equal(merged.status, "resolved");
  if (merged.status === "resolved") {
    assert.equal(merged.strategy, "scip");
    assert.deepEqual(merged.evidenceIds, ["parser:import", "scip:abc"]);
  }

  const conflicting = uniqueTargetGate(input, site, [
    scipCandidate,
    { ...parserCandidate, target: { ...symbol, relativePath: "other.ts", discriminator: "other" } },
  ], ["scip", "imports-exports"]);
  assert.equal(conflicting.status, "ambiguous");
});
