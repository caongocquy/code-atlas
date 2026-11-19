import assert from "node:assert/strict";
import test from "node:test";

import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";

test("CA-01 call facts retain parser-proven callable ownership without changing symbol identities", () => {
  const source = [
    "function outer() {",
    "  function nested() { helper(); }",
    "  nested();",
    "}",
    "helper();",
  ].join("\n");
  const result = extractParsedFacts({
    source, language: "typescript", contentHash: "ca01-callsite-ownership",
    factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion,
    factsSchemaVersion: CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion,
  });
  assert.equal(result.kind, "facts");
  if (result.kind !== "facts") throw new Error("Fact extraction failed");

  const outer = result.facts.symbols.find((symbol) => symbol.name === "outer");
  const nested = result.facts.symbols.find((symbol) => symbol.name === "nested");
  assert.ok(outer && nested);
  assert.equal(result.facts.callSites.length, 3);
  const byLine = new Map(result.facts.callSites.map((site) => [site.range.startLine, site]));
  assert.equal(byLine.get(2)?.callerId, nested.localId);
  assert.equal(byLine.get(3)?.callerId, outer.localId);
  assert.equal(byLine.get(5)?.callerId, undefined);
  assert.deepEqual(result.facts.symbols.map((symbol) => symbol.name), ["outer", "nested"]);
});
