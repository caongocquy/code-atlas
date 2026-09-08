import assert from "node:assert/strict";
import test from "node:test";

import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";

test("fact extraction dispatches by registered language and preserves parser identity", () => {
  const result = extractParsedFacts({
    source: "def run():\n  return 1\n",
    filePath: "src/run.py",
    language: "python",
    contentHash: "python-1",
    factsVersion: "2.0.0",
    factsSchemaVersion: "2.0.0",
  });

  assert.equal(result.kind, "facts");
  if (result.kind === "facts") {
    assert.equal(result.facts.language, "python");
    assert.equal(result.facts.parserIdentity.language, "python");
    assert.equal(result.facts.parserIdentity.packageName, "tree-sitter-python");
    assert.equal(result.facts.parserIdentity.grammarName, "tree-sitter-python");
    assert.equal(result.facts.parserIdentity.runtimeName, "tree-sitter");
  }
});
