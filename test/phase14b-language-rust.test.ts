import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { extractRustFacts, rustFactExtractor } from "../src/core/facts/extractors/rust.js";
import { RUST_CAPABILITIES, rustSemanticAdapter } from "../src/core/graph/resolver/adapters/rust.js";
import { factExtractorInput, runFixtureThroughResolver } from "./helpers/phase14b-language-fixtures.js";

const filePath = "phase14b/rust/main.rs";
const source = readFileSync(new URL("./fixtures/phase14b/rust/main.rs", import.meta.url), "utf8");
const expected = JSON.parse(readFileSync(new URL("./fixtures/phase14b/rust/expected.json", import.meta.url), "utf8")) as { language: string; grammar: string };
const input = factExtractorInput({ filePath, source, language: "rust" });

test("Rust extracts AST-backed modules, aliases, ownership, associated functions, and let assignments", () => {
  const outcome = extractRustFacts(input);
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  assert.equal(expected.language, "rust");
  assert.equal(expected.grammar, "tree-sitter-rust@0.24.0");
  assert.equal(outcome.facts.parseStatus, "complete");
  assert.ok(outcome.facts.modules.some((item) => item.name === "inner"));
  assert.ok(outcome.facts.aliases.some((item) => item.aliasName === "Alias" && item.targetName === "crate::inner::Thing"));
  assert.ok(outcome.facts.symbols.some((item) => item.kind === "class" && item.name === "Thing"));
  assert.ok(outcome.facts.symbols.some((item) => item.kind === "enum" && item.name === "State"));
  assert.ok(outcome.facts.implementations.some((item) => item.relationKind === "trait_impl" && item.targetName === "Render"));
  assert.ok(outcome.facts.members.some((item) => item.memberName === "new" && item.access === "static"));
  assert.ok(outcome.facts.constructors.some((item) => item.constructedTypeName === "Alias"));
  assert.ok(outcome.facts.assignments.some((item) => item.assignmentKind === "declaration"));
});

test("Rust preserves generic, deref, macro, and trait dispatch uncertainty", async () => {
  const outcome = rustFactExtractor.extract(input);
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  const facts = outcome.facts;
  assert.ok(facts);
  const genericCall = facts.callSites.find((item) => item.calleeText === "value.render");
  const macroCall = facts.callSites.find((item) => item.calleeText === "println");
  const traitCall = facts.callSites.find((item) => item.calleeText === "generic");
  assert.ok(genericCall);
  assert.ok(macroCall);
  assert.ok(traitCall);
  const result = await runFixtureThroughResolver({
    name: "rust-uncertainty",
    cases: [{ filePath, source, language: "rust" }],
    sites: [genericCall, macroCall, traitCall].map((call) => ({ sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: filePath, language: "rust" }, localId: call.localId })),
  }, [facts], rustSemanticAdapter);
  const decisions = new Map(result.decisions.map((item) => [item.site.localId, item]));
  assert.ok(["unknown", "unsupported"].includes(decisions.get(genericCall.localId)?.status ?? ""));
  assert.equal(decisions.get(macroCall.localId)?.status, "unsupported");
  assert.ok(["unknown", "unsupported"].includes(decisions.get(traitCall.localId)?.status ?? ""));
  assert.equal(result.usedSourceSemanticFallback, false);
});

test("Rust extraction and resolver output are deterministic across cold and warm runs", async () => {
  const outcome = rustFactExtractor.extract(input);
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  const sites = outcome.facts.callSites.map((call) => ({ sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: filePath, language: "rust" as const }, localId: call.localId }));
  const fixture = { name: "rust-repeat", cases: [{ filePath, source, language: "rust" as const }], sites };
  const cold = await runFixtureThroughResolver(fixture, [outcome.facts], rustSemanticAdapter);
  const repeated = await runFixtureThroughResolver(fixture, [outcome.facts], rustSemanticAdapter);
  const warm = await runFixtureThroughResolver(fixture, [outcome.facts], rustSemanticAdapter, "warm", true, cold.resolverState);
  assert.deepEqual(repeated.normalizedFacts, cold.normalizedFacts);
  assert.deepEqual(repeated.decisions, cold.decisions);
  assert.deepEqual(warm.normalizedFacts, cold.normalizedFacts);
  assert.deepEqual(warm.decisions, cold.decisions);
  assert.equal(warm.resolverState, cold.resolverState);
});

test("Rust adapter exposes its capability floor and rejects non-Rust inputs", () => {
  assert.deepEqual(rustSemanticAdapter.capabilities("rust"), RUST_CAPABILITIES);
  const outcome = rustFactExtractor.extract({ ...input, language: "go" });
  assert.equal(outcome.kind, "infrastructure_failure");
});

test("Rust adapter keeps malformed ASTs explicitly unsupported", () => {
  const outcome = rustFactExtractor.extract(factExtractorInput({ filePath: "bad.rs", language: "rust", source: "fn main( { let x = 1;" }));
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  const evidence = rustSemanticAdapter.normalizeFile(outcome.facts, {
    generationId: "rust-uncertain",
    repositoryIdentity: { id: "repo", identityKey: "repo", rootPath: "/repo", displayName: "repo" },
    sourceUnit: { repositoryId: "repo", relativePath: "bad.rs", language: "rust" },
    resolutionVersion: "14b-2",
  });
  assert.ok(evidence.diagnostics.some((item) => item.code === "parse_uncertain"));
  assert.ok(evidence.diagnostics.some((item) => item.code === "language_capability_unsupported"));
});
