import assert from "node:assert/strict";
import test from "node:test";

import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";

function exportsFrom(source: string) {
  const result = extractParsedFacts({
    source,
    language: "typescript",
    contentHash: "ca01-export-star",
    factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion,
    factsSchemaVersion: CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion,
  });
  assert.equal(result.kind, "facts");
  if (result.kind !== "facts") throw new Error("TypeScript fact extraction failed");
  return result.facts.exports.map(({ exportedName, moduleSpecifier, kind }) => ({ exportedName, moduleSpecifier, kind }));
}

test("bare export star retains parser-proven source module", () => {
  assert.deepEqual(exportsFrom('export * from "./dep.js";'), [
    { exportedName: "*", moduleSpecifier: "./dep.js", kind: "star" },
  ]);
});

test("named and local exports do not become star reexports", () => {
  const named = exportsFrom('export { value } from "./dep.js";');
  assert.equal(named.some((item) => item.kind === "star"), false);
  assert.deepEqual(named, [{ exportedName: "value", moduleSpecifier: "./dep.js", kind: "named" }]);
  assert.equal(exportsFrom('const value = 1; export { value };').some((item) => item.kind === "star"), false);
});
