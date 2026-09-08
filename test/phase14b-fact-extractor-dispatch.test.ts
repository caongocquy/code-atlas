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

test("fact extraction rejects an unregistered language", () => {
  const result = extractParsedFacts({
    source: "def run():\n  return 1\n",
    filePath: "src/run.py",
    language: "python",
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

test("fact extraction dispatches through exactly one registered extractor", () => {
  const original = getLanguageFactExtractor("typescript");
  assert.ok(original);
  let calls = 0;
  const countingExtractor: LanguageFactExtractor = {
    language: "typescript",
    extract(input) {
      calls += 1;
      return original.extract(input);
    },
  };
  registerLanguageFactExtractor(countingExtractor);

  try {
    const result = extractParsedFacts({
      source: "const value = 1;\n",
      filePath: "src/value.ts",
      language: "typescript",
      contentHash: "dispatch-1",
      factsVersion: "2.0.0",
      factsSchemaVersion: "2.0.0",
    });

    assert.equal(result.kind, "facts");
    assert.equal(calls, 1);
  } finally {
    registerLanguageFactExtractor(original);
  }
});
