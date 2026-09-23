import assert from "node:assert/strict";
import test from "node:test";

import { buildEffectiveLexicalRanks, evaluateAmbiguity, normalizeFusionTies } from "../eval/retrieval/run.js";
import type { RankedCandidate, RetrievalSelector } from "../eval/retrieval/metrics.js";
import type { RetrievalEvalCase } from "../eval/retrieval/types.js";
import type { LexicalSearchResult } from "../src/core/lexical/lexical-search.service.js";

const selector = (path: string, name: string): RetrievalSelector => ({
  kind: "symbol", path, name, symbolKind: "function",
});

function item(expectation: "unique-promotion" | "no-promotion"): RetrievalEvalCase {
  return {
    id: "ambiguity-test", query: "run", queryClass: "ambiguous", fixture: "fixture",
    split: "development", profile: "all",
    relevant: expectation === "unique-promotion" ? [selector("src/relevant.ts", "run")] : [],
    forbidden: [selector("src/forbidden.ts", "run"), selector("src/other.ts", "run")],
    exhaustive: false, ambiguous: true, expectation,
  };
}

function candidate(file: string, effectiveRelevance: number): RankedCandidate & { effectiveRelevance: number } {
  return {
    identity: { kind: "symbol", path: file, name: "run", symbolKind: "function" },
    effectiveRelevance,
  };
}

function lexical(file: string, startLine: number, lexicalRankGroup?: string): LexicalSearchResult {
  return {
    score: 0, repoId: "repo", file, symbolName: "run", symbolType: "function", startLine,
    documentId: file, lexicalScore: 0, snippet: "run",
    ...(lexicalRankGroup ? { lexicalRankGroup } : {}),
  };
}

function fused(file: string, startLine: number, lexicalRank?: number, vectorRank?: number) {
  return {
    score: 0, repoId: "repo", file, symbolName: "run", symbolType: "function", startLine,
    fusionScore: 0, lexicalRank, ...(vectorRank === undefined ? {} : { vectorRank }),
  };
}

test("equal fused relevance is reported as a top tie", () => {
  const result = evaluateAmbiguity(item("unique-promotion"), [
    candidate("src/relevant.ts", 1 / 61), candidate("src/forbidden.ts", 1 / 61),
  ]);
  assert.equal(result?.outcome, "top-tie");
  assert.equal(result?.topIdentity, null);
});

test("deterministic candidate order cannot turn a tied result into a promotion", () => {
  const candidates = [candidate("src/relevant.ts", 1 / 61), candidate("src/forbidden.ts", 1 / 61)];
  const forward = evaluateAmbiguity(item("unique-promotion"), candidates);
  const reversed = evaluateAmbiguity(item("unique-promotion"), [...candidates].reverse());
  assert.equal(forward?.outcome, "top-tie");
  assert.deepEqual(reversed, forward);
});

test("explicit lexical rank groups survive evaluator fusion reconstruction", () => {
  const results = [lexical("src/a.ts", 1, "bare-exact:run"), lexical("src/b.ts", 1, "bare-exact:run"), lexical("src/c.ts", 1), lexical("src/d.ts", 1)];
  const lexicalRanks = buildEffectiveLexicalRanks(results);
  const rebuilt = normalizeFusionTies([
    fused("src/a.ts", 1, 7), fused("src/b.ts", 1, 8), fused("src/c.ts", 1, 9), fused("src/d.ts", 1, 10),
  ], new Map(), lexicalRanks, results);
  assert.deepEqual(rebuilt.map((result) => result.lexicalRank), [1, 1, 3, 4]);
  assert.deepEqual(rebuilt.map((result) => result.fusionScore), [1 / 61, 1 / 61, 1 / 63, 1 / 64]);
});

test("duplicate lexical rows retain every production RRF contribution", () => {
  const results = [lexical("src/a.ts", 1, "bare-exact:run"), lexical("src/a.ts", 1, "bare-exact:run"), lexical("src/b.ts", 1, "bare-exact:run"), lexical("src/c.ts", 1)];
  const lexicalRanks = buildEffectiveLexicalRanks(results);
  const rebuilt = normalizeFusionTies([
    fused("src/a.ts", 1, 9), fused("src/b.ts", 1, 9), fused("src/c.ts", 1, 9),
  ], new Map(), lexicalRanks, results);
  assert.deepEqual(rebuilt.map((result) => result.lexicalRank), [1, 1, 4]);
  assert.deepEqual(rebuilt.map((result) => result.fusionScore), [2 / 61, 1 / 61, 1 / 64]);
});

test("graph-only rows do not inherit lexical contributions from a matching result key", () => {
  const lexicalResults = [lexical("src/a.ts", 1, "bare-exact:run")];
  const rebuilt = normalizeFusionTies([fused("src/a.ts", 1, undefined, 2)], new Map(), buildEffectiveLexicalRanks(lexicalResults), lexicalResults);
  assert.equal(rebuilt[0]?.fusionScore, 1 / 62);
  assert.equal(rebuilt[0]?.lexicalRank, undefined);
});

test("semantic evidence may break an explicit lexical tie", () => {
  const lexicalRanks = buildEffectiveLexicalRanks([lexical("src/relevant.ts", 1, "bare-exact:run"), lexical("src/forbidden.ts", 1, "bare-exact:run")]);
  const vectorRanks = new Map([["repo:src/relevant.ts:function:run:1", 1]]);
  const rebuilt = normalizeFusionTies([
    fused("src/relevant.ts", 1, 8, 1), fused("src/forbidden.ts", 1, 8),
  ], vectorRanks, lexicalRanks);
  const result = evaluateAmbiguity(item("unique-promotion"), rebuilt.map((row) => candidate(row.file!, row.fusionScore)));
  assert.equal(result?.outcome, "unique-target-promoted");
});

test("a uniquely ranked contextual relevant candidate remains a promotion", () => {
  const lexicalRanks = buildEffectiveLexicalRanks([lexical("src/relevant.ts", 1), lexical("src/forbidden.ts", 1)]);
  const rebuilt = normalizeFusionTies([fused("src/relevant.ts", 1, 7), fused("src/forbidden.ts", 1, 8)], new Map(), lexicalRanks);
  const result = evaluateAmbiguity(item("unique-promotion"), rebuilt.map((row) => candidate(row.file!, row.fusionScore)));
  assert.equal(result?.outcome, "unique-target-promoted");
});

test("a uniquely top forbidden candidate is a false promotion", () => {
  const result = evaluateAmbiguity(item("no-promotion"), [
    candidate("src/forbidden.ts", 1 / 61), candidate("src/other.ts", 1 / 63),
  ]);
  assert.equal(result?.outcome, "false-promotion");
});
