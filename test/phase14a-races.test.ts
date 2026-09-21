import assert from "node:assert/strict";
import test from "node:test";

import { extractStableFacts } from "../src/core/indexing/filesystem-change-detector.js";
import type { FactExtractionOutcome } from "../src/core/facts/facts-extractor.js";
import type { ParsedFactsBlob } from "../src/core/facts/facts.types.js";

function parsedFacts(contentHash: string): ParsedFactsBlob {
  return {
    factsSchemaVersion: "1",
    factsVersion: "1",
    contentHash,
    language: "typescript",
    parserIdentity: {
      language: "typescript",
      runtimeName: "tree-sitter",
      runtimeVersion: "1",
      packageName: "test",
      grammarName: "test",
      grammarVersion: "1",
    },
    parseStatus: "complete",
    parserDiagnostics: [],
    symbols: [],
    containmentScopes: [],
    imports: [],
    exports: [],
    references: [],
    callSites: [],
    bindingSeeds: [],
    declaredTypeAnnotations: [],
    expressions: [],
    members: [],
    assignments: [],
    parameters: [],
    returns: [],
    constructors: [],
    inheritances: [],
    implementations: [],
    aliases: [],
    modules: [],
    namespaces: [],
  };
}

function readerFromSequence(sequence: Array<{ source: string; contentHash: string }>, order: string[]) {
  let index = 0;
  return async () => {
    const read = sequence[index++] ?? sequence.at(-1)!;
    order.push(`read:${read.contentHash}`);
    return read;
  };
}

function extractorThatRecords(order: string[], hash = "stable"): (read: { source: string; contentHash: string }) => FactExtractionOutcome {
  return (read) => {
    order.push(`extract:${read.contentHash}`);
    return { kind: "facts", facts: parsedFacts(hash) };
  };
}

test("reads after extraction and retries one post-extraction source race", async () => {
  const order: string[] = [];
  const reader = readerFromSequence([
    { source: "old", contentHash: "old" },
    { source: "changed", contentHash: "changed" },
    { source: "new", contentHash: "new" },
    { source: "new", contentHash: "new" },
  ], order);

  const result = await extractStableFacts("file.ts", reader, extractorThatRecords(order));

  assert.deepEqual(order, ["read:old", "extract:old", "read:changed", "read:new", "extract:new", "read:new"]);
  assert.deepEqual(result, { source: "new", facts: parsedFacts("stable") });
});

test("catches a change during extraction even when pre-parse reads were stable", async () => {
  const order: string[] = [];
  const reader = readerFromSequence([
    { source: "same", contentHash: "same" },
    { source: "changed-during-parse", contentHash: "changed" },
    { source: "new", contentHash: "new" },
    { source: "new", contentHash: "new" },
  ], order);

  await extractStableFacts("file.ts", reader, extractorThatRecords(order));

  assert.deepEqual(order, ["read:same", "extract:same", "read:changed", "read:new", "extract:new", "read:new"]);
});

test("aborts after the second mismatch without producing candidate facts", async () => {
  const order: string[] = [];
  const reader = readerFromSequence([
    { source: "one", contentHash: "one" },
    { source: "two", contentHash: "two" },
    { source: "three", contentHash: "three" },
    { source: "four", contentHash: "four" },
  ], order);

  await assert.rejects(
    extractStableFacts("file.ts", reader, extractorThatRecords(order)),
    (error: unknown) => error instanceof Error && error.name === "SourceRaceError",
  );
  assert.deepEqual(order, ["read:one", "extract:one", "read:two", "read:three", "extract:three", "read:four"]);
});

test("caps maxAttempts at two attempts", async () => {
  const order: string[] = [];
  const reader = readerFromSequence([
    { source: "one", contentHash: "one" },
    { source: "two", contentHash: "two" },
    { source: "three", contentHash: "three" },
    { source: "four", contentHash: "four" },
    { source: "five", contentHash: "five" },
    { source: "six", contentHash: "six" },
  ], order);

  await assert.rejects(
    extractStableFacts("file.ts", reader, extractorThatRecords(order), 3),
    (error: unknown) => error instanceof Error && error.name === "SourceRaceError",
  );
  assert.deepEqual(order, ["read:one", "extract:one", "read:two", "read:three", "extract:three", "read:four"]);
});

test("protects cached facts with the stability boundary without parsing again", async () => {
  const order: string[] = [];
  const cached = parsedFacts("stable");
  const reader = readerFromSequence([
    { source: "stable", contentHash: "stable" },
    { source: "stable", contentHash: "stable" },
  ], order);
  let cachedFactReads = 0;

  const result = await extractStableFacts("file.ts", reader, (read) => {
    cachedFactReads += 1;
    order.push(`cached:${read.contentHash}`);
    return { kind: "facts", facts: cached };
  });

  assert.equal(cachedFactReads, 1);
  assert.deepEqual(order, ["read:stable", "cached:stable", "read:stable"]);
  assert.deepEqual(result, { source: "stable", facts: cached });
});
