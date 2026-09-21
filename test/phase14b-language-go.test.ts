import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import test from "node:test";

import { extractGoFacts, goFactExtractor } from "../src/core/facts/extractors/go.js";
import { GO_CAPABILITIES, goSemanticAdapter } from "../src/core/graph/resolver/adapters/go.js";
import { factExtractorInput, runLanguageFixture } from "./helpers/phase14b-language-fixtures.js";

const fixturePath = new URL("./fixtures/phase14b/go/main.go", import.meta.url);
const expectedPath = new URL("./fixtures/phase14b/go/expected.json", import.meta.url);
const source = readFileSync(fixturePath, "utf8");
const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as {
  sites: readonly { callee: string; status: string }[];
  resolverCases: Record<string, string>;
};

const input = factExtractorInput({ filePath: "phase14b/go/main.go", source, language: "go" });

test("Go loads the real fixture and extracts package/imports, receivers, interfaces, and method sets", async () => {
  const result = await runLanguageFixture("go", { extractors: [goFactExtractor], adapter: goSemanticAdapter });
  const facts = result.normalizedFacts[0];
  assert.ok(facts);
  assert.equal(facts.contentHash, createHash("sha256").update(source).digest("hex"));
  assert.equal(facts.parseStatus, "complete");
  assert.deepEqual(facts.modules.map((item) => item.name), ["fixturego", "phase14b/go/main.go"]);
  assert.deepEqual(facts.imports.map((item) => item.moduleSpecifier), ["example.com/remote"]);
  assert.ok(facts.symbols.some((item) => item.kind === "interface" && item.declaredQualifiedName === "fixturego.Reader"));
  assert.ok(facts.parameters.some((item) => item.receiverKind === "go_receiver" && item.typeText === "*Service"));
  assert.equal(facts.parameters.filter((item) => item.receiverKind === "go_receiver" && item.name === "s").length, 2);
  assert.equal(facts.bindingSeeds.filter((item) => item.bindingKind === "receiver" && item.name === "s").length, 2);
  assert.ok(facts.members.some((item) => item.memberName === "Read" && item.memberKind === "method"));
  assert.ok(facts.members.some((item) => item.memberName === "Close" && item.memberKind === "method"));
  assert.equal(facts.implementations.filter((item) => item.targetName === "Reader").length, 4);
  assert.ok(facts.callSites.some((item) => item.calleeText === "s.Read"));
  assert.equal(result.usedSourceSemanticFallback, false);
});

test("Go resolves direct calls and keeps interface dispatch ambiguous", async () => {
  const result = await runLanguageFixture("go", { extractors: [goFactExtractor], adapter: goSemanticAdapter });
  const facts = result.normalizedFacts[0]!;
  const decisions = new Map(result.decisions.map((decision) => [decision.site.localId, decision]));
  const directCall = facts.callSites.find((item) => item.calleeText === "s.Read");
  const interfaceCall = facts.callSites.find((item) => item.calleeText === "r.Dispatch");
  assert.ok(directCall);
  assert.ok(interfaceCall);
  assert.equal(decisions.get(directCall.localId)?.status, expected.sites.find((item) => item.callee === "s.Read")?.status);
  assert.equal(decisions.get(directCall.localId)?.status, "resolved");
  assert.equal(decisions.get(directCall.localId)?.edgeKind, "calls");
  const directEvidence = result.resolverState.evidence[0]?.members.find((item) => item.memberName === "Read");
  assert.equal(directEvidence?.ownerType.kind, "known");
  if (directEvidence?.ownerType.kind === "known") assert.equal(directEvidence.ownerType.symbol.qualifiedName, "fixturego.Service");
  assert.equal(decisions.get(interfaceCall.localId)?.status, "ambiguous");
  assert.equal(result.floorPassed, true);
});

test("Go budget, cold/warm memo reuse, and deterministic extraction are observable", async () => {
  const dependencies = { extractors: [goFactExtractor], adapter: goSemanticAdapter } as const;
  const cold = await runLanguageFixture("go", dependencies);
  const warm = await runLanguageFixture("go", { ...dependencies, memoMode: "warm", parallel: true, resolverState: cold.resolverState });
  const repeated = await runLanguageFixture("go", dependencies);
  const budgeted = await runLanguageFixture("go", { ...dependencies, budget: { candidateExpansions: 0 } });
  assert.deepEqual(repeated.normalizedFacts, cold.normalizedFacts);
  assert.deepEqual(repeated.decisions, cold.decisions);
  assert.deepEqual(warm.normalizedFacts, cold.normalizedFacts);
  assert.deepEqual(warm.decisions, cold.decisions);
  assert.strictEqual(warm.resolverState, cold.resolverState);
  assert.ok(warm.resolverState.memoHitCount > 0);
  assert.ok(budgeted.decisions.some((decision) => decision.status === "budget_exhausted"));
  assert.equal(cold.usedSourceSemanticFallback, false);
});

test("Go adapter exposes capabilities and explicit uncertainty", () => {
  assert.deepEqual(goSemanticAdapter.capabilities("go"), GO_CAPABILITIES);
  const outcome = goFactExtractor.extract(factExtractorInput({ filePath: "bad.go", source: "package demo\nfunc (", language: "go" }));
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  const evidence = goSemanticAdapter.normalizeFile(outcome.facts, {
    generationId: "go-uncertain",
    repositoryIdentity: { id: "repo", identityKey: "repo", rootPath: "/repo", displayName: "repo" },
    sourceUnit: { repositoryId: "repo", relativePath: "bad.go", language: "go" },
    resolutionVersion: "14b-2",
  });
  assert.ok(evidence.diagnostics.some((item) => item.code === "parse_uncertain"));
  assert.ok(evidence.diagnostics.some((item) => item.code === "language_capability_unsupported"));
});
