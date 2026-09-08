import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { cFactExtractor } from "../src/core/facts/extractors/c.js";
import { cppFactExtractor } from "../src/core/facts/extractors/cpp.js";
import { C_CAPABILITIES, CPP_CAPABILITIES, cFamilySemanticAdapter } from "../src/core/graph/resolver/adapters/c-family.js";
import { factExtractorInput, runFixtureThroughResolver } from "./helpers/phase14b-language-fixtures.js";

const cSource = `#include <stdio.h>\ntypedef int Number;\nstruct Point { int x; };\nint add(int value) { return value; }\nint main(void) { int (*fp)(int) = add; return add(1); }\n`;
const cppSource = `namespace demo { using Number = int; struct Base {}; class Child : public Base { int value; public: Child(int input) : value(input) {} int run() { return value; } }; template<class T> T identity(T value) { return value; } } int pick(int value) { return value; } double pick(double value) { return value; } int main() { demo::Child child(1); int (*pointer)(int) = pick; return child.run(); }`;
const input = factExtractorInput({ filePath: "phase14b/c/main.c", source: cSource, language: "c" });
const cppInput = factExtractorInput({ filePath: "phase14b/cpp/main.cpp", source: cppSource, language: "cpp" });

test("C family uses the pinned native parser identities and extracts structural facts", () => {
  const c = cFactExtractor.extract(input); const cpp = cppFactExtractor.extract(cppInput);
  assert.equal(c.kind, "facts"); assert.equal(cpp.kind, "facts"); if (c.kind !== "facts" || cpp.kind !== "facts") return;
  assert.deepEqual([c.facts.parserIdentity.packageName, c.facts.parserIdentity.grammarVersion], ["tree-sitter-c", "0.24.1"]);
  assert.deepEqual([cpp.facts.parserIdentity.packageName, cpp.facts.parserIdentity.grammarVersion], ["tree-sitter-cpp", "0.23.4"]);
  assert.ok(c.facts.symbols.some((item) => item.name === "add" && item.kind === "function")); assert.ok(c.facts.imports.some((item) => item.moduleSpecifier === "stdio.h")); assert.ok(c.facts.aliases.some((item) => item.aliasName === "Number"));
  assert.ok(cpp.facts.namespaces.some((item) => item.name === "demo")); assert.ok(cpp.facts.inheritances.some((item) => item.targetName === "Base")); assert.ok(cpp.facts.constructors.some((item) => item.constructedTypeName.includes("Child")));
  assert.equal(readFileSync(new URL("./fixtures/phase14b/c/expected.json", import.meta.url), "utf8").includes("exact-function-pointers"), true);
});

test("C resolves direct calls, keeps pointer ambiguity conservative, and preserves exact ranges", async () => {
  const outcome = cFactExtractor.extract(input); assert.equal(outcome.kind, "facts"); if (outcome.kind !== "facts") return;
  const call = outcome.facts.callSites.find((item) => item.calleeText === "add")!; assert.equal(call.range.startLine, 5); assert.equal(call.range.endLine, 5);
  const fixture = { name: "c-family", cases: [{ filePath: input.filePath, source: cSource, language: "c" as const }], sites: [{ sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: input.filePath, language: "c" as const }, localId: call.localId }] };
  const result = await runFixtureThroughResolver(fixture, [outcome.facts], cFamilySemanticAdapter); assert.equal(result.decisions[0]?.status, "resolved"); assert.equal(result.usedSourceSemanticFallback, false);
  const pointer = outcome.facts.assignments.find((item) => item.assignmentKind === "function_pointer"); assert.ok(pointer); assert.ok(result.resolverState.evidence[0]?.assignments.some((item) => item.targetBindingId === pointer?.targetId));
});

test("C++ explicitly marks compiler-dependent template semantics unsupported", () => {
  const outcome = cppFactExtractor.extract(cppInput); assert.equal(outcome.kind, "facts"); if (outcome.kind !== "facts") return;
  assert.ok(outcome.facts.symbols.some((item) => item.name === "identity")); const evidence = cFamilySemanticAdapter.normalizeFile(outcome.facts, { generationId: "cpp-test", repositoryIdentity: { id: "repo", identityKey: "repo", rootPath: "/repo", displayName: "repo" }, sourceUnit: { repositoryId: "repo", relativePath: cppInput.filePath, language: "cpp" }, resolutionVersion: "14b-2" });
  assert.ok(evidence.diagnostics.some((item) => item.code === "compiler_semantics_required")); assert.ok(evidence.diagnostics.some((item) => item.code === "multiple_candidates")); assert.deepEqual(cFamilySemanticAdapter.capabilities("c"), C_CAPABILITIES); assert.deepEqual(cFamilySemanticAdapter.capabilities("cpp"), CPP_CAPABILITIES);
});

test("C-family extraction is deterministic and warm memo reuse/budget exhaustion are observable", async () => {
  const first = cFactExtractor.extract(input); const second = cFactExtractor.extract(input); assert.deepEqual(second, first); assert.equal(first.kind, "facts"); if (first.kind !== "facts") return;
  const call = first.facts.callSites.find((item) => item.calleeText === "add")!; const fixture = { name: "c-budget", cases: [{ filePath: input.filePath, source: cSource, language: "c" as const }], sites: [{ sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: input.filePath, language: "c" as const }, localId: call.localId }] };
  const cold = await runFixtureThroughResolver(fixture, [first.facts], cFamilySemanticAdapter); const warm = await runFixtureThroughResolver(fixture, [first.facts], cFamilySemanticAdapter, "warm", true, cold.resolverState); const exhausted = await runFixtureThroughResolver(fixture, [first.facts], cFamilySemanticAdapter, "cold", false, undefined, { candidateExpansions: 0 });
  assert.deepEqual(warm.decisions, cold.decisions); assert.ok(warm.resolverState.memoHitCount > 0); assert.ok(exhausted.decisions.some((item) => item.status === "budget_exhausted"));
});
