import assert from "node:assert/strict";
import test from "node:test";

import { decodeFacts, encodeFacts } from "../src/core/facts/facts-codec.js";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { factBlobKey } from "../src/core/facts/facts-identity.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";

function extract(source: string, language: "typescript" | "javascript" = "typescript") {
  const result = extractParsedFacts({
    source, language, contentHash: "ca01-fact-provenance",
    factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion,
    factsSchemaVersion: CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion,
  });
  if (result.kind !== "facts") throw result.error;
  assert.equal(result.facts.parseStatus, "complete");
  return result.facts;
}

test("CA-01 removes duplicate annotations and declaration references without renumbering surviving facts", () => {
  const facts = extract(`
import { helper as alias } from "./dep.js";
export const value: Result = helper();
class Service {
  run(input: Input): Result { return alias(input); }
}
function outer() {
  const nested = () => value;
  return nested();
}
export { Service };
`);
  assert.deepEqual(facts.references.map(({ name, localId }) => [name, localId]), [
    ["helper", "reference:11"], ["alias", "reference:24"], ["input", "reference:25"],
    ["value", "reference:36"], ["nested", "reference:40"],
  ]);
  assert.deepEqual(facts.symbols.map(({ localId }) => localId), [
    "symbol:13", "symbol:15", "symbol:27", "symbol:33",
  ]);
  assert.deepEqual(facts.declaredTypeAnnotations.map(({ localId, ownerId, text }) => [localId, ownerId, text]), [
    ["type:6", "binding:5", "Result"],
    ["type:16", "symbol:15", "Result"],
    ["type:19", "binding:17", "Input"],
  ]);
  const encoded = encodeFacts(facts);
  const expected = {
    key: factBlobKey(facts),
    contentHash: facts.contentHash,
    language: facts.language,
    parserIdentity: facts.parserIdentity,
    factsVersion: facts.factsVersion,
    factsSchemaVersion: facts.factsSchemaVersion,
  };
  assert.equal(decodeFacts(encoded, expected).kind, "hit");
  const old = { ...facts, factsVersion: "3.1.4" };
  assert.notEqual(factBlobKey(old), expected.key);
  assert.deepEqual(decodeFacts(encodeFacts(old), expected), { kind: "miss", reason: "version_mismatch" });
});

test("CA-01 keeps actual recursive references and separate annotations with the same type", () => {
  const facts = extract("function recurse(n: number): number { const a: number = n; const b: number = a; return recurse(b); }");
  const fn = facts.symbols.find((symbol) => symbol.name === "recurse");
  assert.ok(fn);
  const recursiveReferences = facts.references.filter((reference) => reference.name === "recurse");
  assert.equal(recursiveReferences.length, 1);
  assert.equal(recursiveReferences[0]?.ownerId, fn.localId);
  const annotations = facts.declaredTypeAnnotations.filter((annotation) => annotation.text === "number");
  assert.equal(annotations.length, 4);
  const expectedOwners = [fn.localId, ...facts.bindingSeeds.filter((seed) => ["n", "a", "b"].includes(seed.name)).map((seed) => seed.localId)];
  assert.deepEqual(new Set(annotations.map((annotation) => annotation.ownerId)), new Set(expectedOwners));
});

test("CA-01 keeps JavaScript declaration syntax while excluding the declaration name from references", () => {
  const facts = extract("function recurse() { return recurse(); }", "javascript");
  const fn = facts.symbols.find((symbol) => symbol.name === "recurse");
  assert.ok(fn);
  assert.equal(facts.references.filter((reference) => reference.name === "recurse").length, 1);
  assert.equal(facts.callSites[0]?.callerId, fn.localId);
  assert.equal(facts.callSites[0]?.calleeText, "recurse");
});
