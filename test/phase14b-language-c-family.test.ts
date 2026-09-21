import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { cFactExtractor } from "../src/core/facts/extractors/c.js";
import { cppFactExtractor } from "../src/core/facts/extractors/cpp.js";
import { C_CAPABILITIES, CPP_CAPABILITIES, cFamilySemanticAdapter } from "../src/core/graph/resolver/adapters/c-family.js";
import { factExtractorInput, runFixtureThroughResolver } from "./helpers/phase14b-language-fixtures.js";

const cSource = `#include <stdio.h>\ntypedef int Number;\nstruct Point { int x; };\nint add(int value) { return value; }\nint main(void) { struct Point point = {1}; int (*ok)(int) = add; int (*bad)(double) = add; int value = 1; int *p = &value; return add(point.x); }\n`;
const cppSource = `namespace demo { using Number = int; using Alias = demo::Number; using demo::Thing; struct Base {}; class Child : public Base { int value; public: Child(int input) : value(input) {} int run() { return value; } }; template<class T> T identity(T value) { return value; } } int pick(int value) { return value; } double pick(double value) { return value; } int main() { demo::Child child(1); int (*pointer)(int) = pick; return child.run(); }`;
const input = factExtractorInput({ filePath: "phase14b/c/main.c", source: cSource, language: "c" });
const cppInput = factExtractorInput({ filePath: "phase14b/cpp/main.cpp", source: cppSource, language: "cpp" });

test("C family uses the pinned native parser identities and extracts structural facts", () => {
  const c = cFactExtractor.extract(input); const cpp = cppFactExtractor.extract(cppInput);
  assert.equal(c.kind, "facts"); assert.equal(cpp.kind, "facts"); if (c.kind !== "facts" || cpp.kind !== "facts") return;
  assert.deepEqual([c.facts.parserIdentity.packageName, c.facts.parserIdentity.grammarVersion], ["tree-sitter-c", "0.24.1"]);
  assert.deepEqual([cpp.facts.parserIdentity.packageName, cpp.facts.parserIdentity.grammarVersion], ["tree-sitter-cpp", "0.23.4"]);
  assert.ok(c.facts.symbols.some((item) => item.name === "add" && item.kind === "function")); assert.ok(c.facts.imports.some((item) => item.moduleSpecifier === "stdio.h")); assert.ok(c.facts.aliases.some((item) => item.aliasName === "Number"));
  assert.ok(c.facts.symbols.some((item) => item.name === "Point" && item.kind === "class")); assert.ok(c.facts.symbols.some((item) => item.name === "point" && item.kind === "variable")); assert.ok(c.facts.members.some((item) => item.memberName === "x"));
  assert.ok(cpp.facts.namespaces.some((item) => item.name === "demo")); assert.ok(cpp.facts.inheritances.some((item) => item.targetName === "Base")); assert.ok(cpp.facts.constructors.some((item) => item.constructedTypeName.includes("Child"))); assert.ok(cpp.facts.aliases.some((item) => item.aliasName === "Number")); assert.ok(cpp.facts.aliases.some((item) => item.aliasName === "Alias")); assert.ok(cpp.facts.aliases.some((item) => item.targetName === "demo::Thing"));
  const cExpected = JSON.parse(readFileSync(new URL("./fixtures/phase14b/c/expected.json", import.meta.url), "utf8")) as { requiredFacts: readonly string[] };
  const cppExpected = JSON.parse(readFileSync(new URL("./fixtures/phase14b/cpp/expected.json", import.meta.url), "utf8")) as { requiredFacts: readonly string[] };
  assert.ok(cExpected.requiredFacts.includes("exact-function-pointers")); assert.deepEqual(cppExpected.requiredFacts, ["namespaces", "classes", "structs", "methods", "constructors", "inheritance", "direct-members", "aliases"]);
});

test("C resolves direct calls, keeps pointer ambiguity conservative, and preserves exact ranges", async () => {
  const outcome = cFactExtractor.extract(input); assert.equal(outcome.kind, "facts"); if (outcome.kind !== "facts") return;
  const call = outcome.facts.callSites.find((item) => item.calleeText === "add")!; assert.equal(call.range.startLine, 5); assert.equal(call.range.endLine, 5);
  const fixture = { name: "c-family", cases: [{ filePath: input.filePath, source: cSource, language: "c" as const }], sites: [{ sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: input.filePath, language: "c" as const }, localId: call.localId }] };
  const result = await runFixtureThroughResolver(fixture, [outcome.facts], cFamilySemanticAdapter); assert.equal(result.decisions[0]?.status, "resolved"); assert.equal(result.usedSourceSemanticFallback, false);
  const pointer = outcome.facts.assignments.find((item) => item.assignmentKind === "function_pointer" && outcome.facts.bindingSeeds.find((binding) => binding.localId === item.targetId)?.name === "ok"); assert.ok(pointer); const pointerType = outcome.facts.declaredTypeAnnotations.find((item) => item.ownerId === pointer?.targetId); assert.equal(pointerType?.text, "function_pointer:int(int)"); const exactEvidence = result.resolverState.evidence[0]?.assignments.find((item) => item.targetBindingId === pointer?.targetId); assert.ok(exactEvidence); assert.equal(exactEvidence?.sourceType?.kind, "known"); if (exactEvidence?.sourceType?.kind === "known") assert.equal(exactEvidence.sourceType.symbol.qualifiedName, "add");
  const bad = outcome.facts.assignments.find((item) => outcome.facts.bindingSeeds.find((binding) => binding.localId === item.targetId)?.name === "bad"); const ordinary = outcome.facts.assignments.find((item) => outcome.facts.bindingSeeds.find((binding) => binding.localId === item.targetId)?.name === "p"); assert.equal(bad?.assignmentKind, "function_pointer"); assert.equal(ordinary?.assignmentKind, "declaration"); assert.equal(result.resolverState.evidence[0]?.assignments.some((item) => item.targetBindingId === bad?.targetId), false); assert.equal(result.resolverState.evidence[0]?.assignments.some((item) => item.targetBindingId === ordinary?.targetId && item.sourceType), false);
});

test("production facts dispatch includes C and C++ extractors", () => {
  for (const [language, filePath, source, packageName] of [["c", "dispatch.c", cSource, "tree-sitter-c"], ["cpp", "dispatch.cpp", cppSource, "tree-sitter-cpp"]] as const) {
    const result = extractParsedFacts({ language, filePath, source, contentHash: `${language}-dispatch`, factsVersion: "2.0.0", factsSchemaVersion: "2.0.0" });
    assert.equal(result.kind, "facts", language); if (result.kind !== "facts") continue; assert.equal(result.facts.parserIdentity.packageName, packageName); assert.equal(result.facts.language, language);
  }
});

test("preprocessor conditionals are explicit unsupported semantics", async () => {
  const source = `#if FEATURE\nint selected(void) { return 1; }\n#else\nint selected(void) { return 2; }\n#endif\nint main(void) { return selected(); }`;
  const outcome = cFactExtractor.extract(factExtractorInput({ filePath: "phase14b/c/preprocessor.c", source, language: "c" })); assert.equal(outcome.kind, "facts"); if (outcome.kind !== "facts") return;
  assert.ok(outcome.facts.parserDiagnostics.some((item) => item.startsWith("preprocessor_semantics:"))); const evidence = cFamilySemanticAdapter.normalizeFile(outcome.facts, { generationId: "preprocessor-test", repositoryIdentity: { id: "phase14b-fixtures", identityKey: "phase14b-fixtures", rootPath: "/phase14b-fixtures", displayName: "phase14b-fixtures" }, sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: "phase14b/c/preprocessor.c", language: "c" }, resolutionVersion: "14b-2" }); assert.ok(evidence.diagnostics.some((item) => item.code === "preprocessor_semantics_required"));
  const call = outcome.facts.callSites.find((item) => item.calleeText === "selected"); assert.ok(call); const result = await runFixtureThroughResolver({ name: "c-preprocessor", cases: [{ filePath: "phase14b/c/preprocessor.c", source, language: "c" }], sites: [{ sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: "phase14b/c/preprocessor.c", language: "c" }, localId: call!.localId }] }, [outcome.facts], cFamilySemanticAdapter); assert.equal(result.decisions[0]?.status, "unsupported");
});

test("C++ direct member calls resolve to the AST-owned method", async () => {
  const source = "struct Child { int go() { return 1; } }; int main() { Child child; return child.go(); }";
  const outcome = cppFactExtractor.extract(factExtractorInput({ filePath: "phase14b/cpp/direct-member.cpp", source, language: "cpp" })); assert.equal(outcome.kind, "facts"); if (outcome.kind !== "facts") return;
  const declaration = outcome.facts.members.find((item) => item.memberName === "go" && item.ownerSymbolId); const call = outcome.facts.callSites.find((item) => item.calleeText === "child.go"); assert.ok(declaration); assert.ok(call);
  const result = await runFixtureThroughResolver({ name: "cpp-direct-member", cases: [{ filePath: "phase14b/cpp/direct-member.cpp", source, language: "cpp" }], sites: [{ sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: "phase14b/cpp/direct-member.cpp", language: "cpp" }, localId: call!.localId }] }, [outcome.facts], cFamilySemanticAdapter);
  assert.equal(result.decisions[0]?.status, "resolved"); if (result.decisions[0]?.status === "resolved") assert.equal(result.decisions[0].target.qualifiedName, "Child::go");
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
