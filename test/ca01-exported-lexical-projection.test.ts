import assert from "node:assert/strict";
import test from "node:test";

import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { codeChunksFromFacts } from "../src/core/indexing/indexing.types.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";

function chunks(source: string) {
  const result = extractParsedFacts({
    source, language: "typescript", contentHash: "ca01-lexical-projection",
    factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion,
    factsSchemaVersion: CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion,
  });
  assert.equal(result.kind, "facts");
  if (result.kind !== "facts") throw new Error("Fact extraction failed");
  const graphSymbolCount = result.facts.symbols.length;
  return {
    graphSymbolCount,
    graphSymbols: result.facts.symbols.map((symbol) => symbol.name),
    chunks: codeChunksFromFacts({ relativePath: "source.ts", source, facts: result.facts }),
  };
}

test("CA-01 exported const declarators contribute exact lexical chunks without graph symbols", () => {
  const result = chunks("export const first = 1; export const second = 2;\n");
  assert.equal(result.graphSymbolCount, 0);
  assert.deepEqual(result.chunks.map((chunk) => chunk.content), ["const first = 1;", "const second = 2;"]);
  assert.deepEqual(result.chunks.map((chunk) => chunk.symbolName), ["first", "second"]);
});

test("CA-01 lexical projection does not invent non-exported or destructured symbols", () => {
  const result = chunks("const internal = 1; export const { first } = source;\n");
  assert.equal(result.graphSymbolCount, 0);
  assert.deepEqual(result.chunks, []);
});

test("CA-01 lexical projection preserves function-only document identity", () => {
  const result = chunks("export function answer() { return 42; }\n");
  assert.deepEqual(result.graphSymbols, ["answer"]);
  assert.deepEqual(result.chunks.map((chunk) => chunk.symbolName), ["answer"]);
});
