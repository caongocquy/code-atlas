import assert from "node:assert/strict";
import test from "node:test";

import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";

test("CA-01 binding seeds preserve import, local and parameter declarations with parser-proven ownership", (t) => {
  const result = extractParsedFacts({
    source: [
      'import { helper as alias } from "./dep.js";',
      "export const value: Result = helper();",
      "class Service {",
      "  run(input: Input): Result { return alias(input); }",
      "}",
      "function outer() {",
      "  const nested = () => value;",
      "  return nested();",
      "}",
      "export { Service };",
    ].join("\n"),
    language: "typescript",
    contentHash: "ca01-binding-seed-ownership",
    factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion,
    factsSchemaVersion: CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion,
  });
  assert.equal(result.kind, "facts");
  if (result.kind !== "facts") throw new Error("Fact extraction failed");

  const { bindingSeeds, containmentScopes, symbols, parameters } = result.facts;
  assert.equal(result.facts.parseStatus, "complete");
  assert.deepEqual(
    bindingSeeds.map(({ name, bindingKind }) => [name, bindingKind]),
    [["alias", "import"], ["value", "local"], ["input", "parameter"], ["nested", "local"]],
  );
  assert.equal(new Set(bindingSeeds.map((seed) => seed.localId)).size, bindingSeeds.length);

  const moduleScope = containmentScopes.find((scope) => scope.kind === "program");
  const method = symbols.find((symbol) => symbol.name === "run" && symbol.kind === "method");
  const outer = symbols.find((symbol) => symbol.name === "outer" && symbol.kind === "function");
  assert.ok(moduleScope && method?.scopeId && outer?.scopeId);
  const alias = bindingSeeds.find((seed) => seed.name === "alias");
  const value = bindingSeeds.find((seed) => seed.name === "value");
  const input = bindingSeeds.find((seed) => seed.name === "input");
  const nested = bindingSeeds.find((seed) => seed.name === "nested");
  assert.ok(alias && value && input && nested);
  assert.equal(alias.sourceModule, "./dep.js");
  assert.equal(alias.importedName, "helper");
  assert.equal(alias.ownerId, moduleScope.localId);
  assert.equal(value.ownerId, moduleScope.localId);
  assert.equal(input.ownerId, method.scopeId);
  assert.equal(nested.ownerId, outer.scopeId);

  const parameter = parameters.find((fact) => fact.ownerSymbolId === method.localId && fact.name === "input");
  assert.ok(parameter);
  assert.equal(parameter.bindingId, input.localId);
  assert.equal(parameter.index, 0);

  // Capture downstream fixture evidence without changing unrelated expectations.
  t.diagnostic(JSON.stringify({
    references: result.facts.references,
    declaredTypeAnnotations: result.facts.declaredTypeAnnotations,
    symbols: result.facts.symbols,
  }));
});
