import assert from "node:assert/strict";
import test from "node:test";
import Parser from "tree-sitter";

import { buildCodeGraphWithResolutionFromFacts } from "../src/core/graph/build-graph.js";
import { toLexicalDocumentsFromFacts } from "../src/core/lexical/lexical-index.service.js";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import type { IndexedSourceUnit } from "../src/core/indexing/indexing.types.js";

function unit(relativePath: string, source: string): IndexedSourceUnit {
  const extracted = extractParsedFacts({
    source,
    language: "typescript",
    contentHash: `${relativePath}:${source}`,
    factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion,
    factsSchemaVersion: "1.0.0",
  });
  assert.equal(extracted.kind, "facts");
  if (extracted.kind !== "facts") throw extracted.error;
  return { relativePath, source, facts: extracted.facts };
}

test("one materialized fact unit feeds graph and lexical consumers without another extraction", async () => {
  const source = "export function answer() { return 42; }\n";
  const indexed = unit("answer.ts", source);
  const graph = await buildCodeGraphWithResolutionFromFacts("/tmp/repo", [indexed]);
  const documents = toLexicalDocumentsFromFacts("repo", indexed);

  assert.ok(graph.graph.nodes.some((node) => node.qualifiedName === "answer"));
  assert.equal(documents.length, indexed.facts.symbols.length);
  assert.match(documents[0]?.content ?? "", /return 42/);
});

test("parser calls equal cold and modified fact misses, while unchanged units reuse facts", async () => {
  const originalParse = Parser.prototype.parse;
  let parserCalls = 0;
  Parser.prototype.parse = function (...args: Parameters<typeof originalParse>) {
    parserCalls += 1;
    return originalParse.apply(this, args);
  };

  try {
    const first = unit("first.ts", "export function first() { return 1; }\n");
    const second = unit("second.ts", "export function second() { return 2; }\n");
    assert.equal(parserCalls, 2);

    await buildCodeGraphWithResolutionFromFacts("/tmp/repo", [first, second]);
    toLexicalDocumentsFromFacts("repo", first);
    assert.equal(parserCalls, 2);

    const unchanged = [first, second];
    assert.equal(unchanged.length, 2);
    assert.equal(parserCalls, 2);

    unit("second.ts", "export function second() { return 3; }\n");
    assert.equal(parserCalls, 3);
  } finally {
    Parser.prototype.parse = originalParse;
  }
});
