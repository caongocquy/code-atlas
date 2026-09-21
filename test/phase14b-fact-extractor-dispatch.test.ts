import assert from "node:assert/strict";
import test from "node:test";

import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import {
  getLanguageFactExtractor,
  registerLanguageFactExtractor,
  type LanguageFactExtractor,
} from "../src/core/facts/language-fact-extractor.js";

test("fact extraction dispatches by registered TypeScript language and preserves parser identity", () => {
  const result = extractParsedFacts({
    source: "function run(): number { return 1; }\n",
    filePath: "src/run.ts",
    language: "typescript",
    contentHash: "typescript-1",
    factsVersion: "2.0.0",
    factsSchemaVersion: "2.0.0",
  });

  assert.equal(result.kind, "facts");
  if (result.kind === "facts") {
    assert.equal(result.facts.language, "typescript");
    assert.equal(result.facts.parserIdentity.language, "typescript");
    assert.equal(result.facts.parserIdentity.packageName, "tree-sitter-typescript");
    assert.equal(result.facts.parserIdentity.grammarName, "tree-sitter-typescript");
    assert.equal(result.facts.parserIdentity.runtimeName, "tree-sitter");
  }
});

test("fact extraction rejects an unknown language", () => {
  const result = extractParsedFacts({
    source: "def run():\n  return 1\n",
    filePath: "src/run.py",
    language: "unknown" as never,
    contentHash: "python-1",
    factsVersion: "2.0.0",
    factsSchemaVersion: "2.0.0",
  });

  assert.equal(result.kind, "infrastructure_failure");
});

test("fact extraction rejects a file path whose parser language mismatches input language", () => {
  const result = extractParsedFacts({
    source: "const value = 1;\n",
    filePath: "src/value.js",
    language: "typescript",
    contentHash: "mismatch-1",
    factsVersion: "2.0.0",
    factsSchemaVersion: "2.0.0",
  });

  assert.equal(result.kind, "infrastructure_failure");
});

test("duplicate extractor registration fails loudly", () => {
  const original = getLanguageFactExtractor("typescript");
  assert.ok(original);
  const countingExtractor: LanguageFactExtractor = {
    language: "typescript",
    extract: original.extract,
  };
  assert.throws(() => registerLanguageFactExtractor(countingExtractor), /already registered for typescript/);
  assert.strictEqual(getLanguageFactExtractor("typescript"), original);
});
