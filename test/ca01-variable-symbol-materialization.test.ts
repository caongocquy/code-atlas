import assert from "node:assert/strict";
import test from "node:test";

import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import { codeChunksFromFacts } from "../src/core/indexing/indexing.types.js";

function fixture(source: string) {
  const outcome = extractParsedFacts({
    source, language: "typescript", contentHash: "ca01-variable-materialization",
    factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion,
    factsSchemaVersion: CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion,
  });
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") throw new Error("TypeScript extraction failed");
  return { relativePath: "source.ts", source, facts: outcome.facts };
}

test("CA-01 simple const declarations produce exact same-line lexical chunks", () => {
  const input = fixture("export const first = 1; export const second = 2;\n");
  const chunks = codeChunksFromFacts(input).filter(chunk => chunk.symbolType === "variable");
  assert.deepEqual(chunks.map(chunk => [chunk.symbolName, chunk.content]), [
    ["first", "const first = 1;"],
    ["second", "const second = 2;"],
  ]);
  assert.equal(input.facts.bindingSeeds.filter(binding => ["first", "second"].includes(binding.name)).length, 2);
});

test("CA-01 destructuring declaration does not invent one variable symbol for a compound pattern", () => {
  const input = fixture("const { first, second } = source;\n");
  assert.equal(input.facts.symbols.some(symbol => symbol.kind === "variable" && symbol.name.includes("{")), false);
});
