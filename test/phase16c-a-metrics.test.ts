import assert from "node:assert/strict";
import test from "node:test";

import { aggregateRankingMetrics, canonicalIdentity, evaluateRanking } from "../eval/retrieval/metrics.js";
import type { RankedCandidate, RetrievalSelector } from "../eval/retrieval/metrics.js";

const symbol = (path: string, name: string, startLine?: number): RankedCandidate => ({
  identity: { kind: "symbol", path, name, symbolKind: "function", startLine },
  startLine,
});
const selector = (path: string, name: string): RetrievalSelector => ({
  kind: "symbol", path, name, symbolKind: "function",
});

test("canonical identities ignore generated IDs and normalize relative path separators", () => {
  assert.equal(canonicalIdentity({ kind: "file", path: "./src\\main.ts" }), canonicalIdentity({ kind: "file", path: "src/main.ts" }));
});

test("ranking metrics count multiple relevant symbols without letting duplicates inflate recall", () => {
  const metrics = evaluateRanking([
    symbol("src/noise.ts", "noise", 1),
    symbol("src/core.ts", "alpha", 2),
    symbol("src/core.ts", "alpha", 2),
    symbol("src/core.ts", "beta", 8),
  ], {
    relevant: [selector("src/core.ts", "alpha"), selector("src/core.ts", "beta")],
    exhaustive: true,
  });
  assert.equal(metrics.hitAt1, 0);
  assert.equal(metrics.hitAt3, 1);
  assert.equal(metrics.mrrAt5, 0.5);
  assert.equal(metrics.recallAt5, 1);
  assert.equal(metrics.precisionAt5, 2 / 5);
  assert.equal(metrics.canonicalDuplicateRate, 0.25);
  assert.equal(metrics.chunkDuplicateRate, 0.25);
});

test("no relevant results score zero and partial judgments preserve the unjudged count", () => {
  const empty = evaluateRanking([], { relevant: [selector("src/target.ts", "target")], exhaustive: true });
  assert.equal(empty.hitAt1, 0);
  assert.equal(empty.recallAt10, 0);
  assert.equal(empty.precisionAt5, 0);
  const metrics = evaluateRanking([symbol("src/other.ts", "unknown", 1)], {
    relevant: [selector("src/target.ts", "target")],
    exhaustive: false,
  });
  assert.equal(metrics.hitAt1, 0);
  assert.equal(metrics.mrrAt5, 0);
  assert.equal(metrics.recallAt10, 0);
  assert.equal(metrics.precisionAt5, undefined);
  assert.equal(metrics.judgedNoiseRate, 0);
  assert.equal(metrics.unjudgedCount, 1);
});

test("forbidden top result is counted as ambiguity false promotion", () => {
  const metrics = evaluateRanking([symbol("src/other.ts", "findById", 1)], {
    relevant: [selector("src/users.ts", "findById")],
    forbidden: [selector("src/orders.ts", "findById")],
    exhaustive: false,
    ambiguous: true,
  });
  assert.equal(metrics.ambiguityFalsePromotion, 0);
  const promoted = evaluateRanking([symbol("src/orders.ts", "findById", 1)], {
    relevant: [selector("src/users.ts", "findById")],
    forbidden: [selector("src/orders.ts", "findById")],
    exhaustive: false,
    ambiguous: true,
  });
  assert.equal(promoted.ambiguityFalsePromotion, 1);
  assert.equal(promoted.judgedNoiseRate, 1);
  assert.equal(promoted.unjudgedCount, 0);
  const ordinary = evaluateRanking([symbol("src/users.ts", "findById", 1)], { relevant: [selector("src/users.ts", "findById")], exhaustive: false });
  assert.equal(aggregateRankingMetrics([ordinary, promoted]).ambiguityFalsePromotion, 1);
  assert.equal(aggregateRankingMetrics([ordinary, promoted]).ambiguityCaseCount, 1);
});

test("equal-ranked inputs preserve stable caller order for deterministic tie handling", () => {
  const first = symbol("src/first.ts", "first", 1);
  const second = symbol("src/second.ts", "second", 1);
  const judgments = { relevant: [selector("src/first.ts", "first")], exhaustive: false };
  assert.equal(evaluateRanking([first, second], judgments).mrrAt5, 1);
  assert.equal(evaluateRanking([second, first], judgments).mrrAt5, 0.5);
});

test("supporting selectors count for coverage and ranking", () => {
  const metrics = evaluateRanking([symbol("src/dependency.ts", "loadDependency", 1)], {
    relevant: [selector("src/entry.ts", "entry")],
    supporting: [selector("src/dependency.ts", "loadDependency")],
    exhaustive: false,
  });
  assert.equal(metrics.hitAt1, 1);
  assert.equal(metrics.recallAt5, 0.5);
  assert.equal(metrics.relevantSymbolCoverage, 0.5);
});

test("judged coverage counts relevant, supporting, irrelevant, and forbidden top-K candidates", () => {
  const metrics = evaluateRanking([
    symbol("src/target.ts", "target", 1),
    symbol("src/context.ts", "context", 2),
    symbol("src/known-noise.ts", "knownNoise", 3),
    symbol("src/ambiguous.ts", "ambiguous", 4),
    symbol("src/unknown.ts", "unknown", 5),
  ], {
    relevant: [selector("src/target.ts", "target")],
    supporting: [selector("src/context.ts", "context")],
    irrelevant: [selector("src/known-noise.ts", "knownNoise")],
    forbidden: [selector("src/ambiguous.ts", "ambiguous")],
    exhaustive: false,
  });
  assert.equal(metrics.judgedCoverageAt5, 0.8);
  assert.equal(metrics.judgedCoverageAt10, 0.8);
  assert.equal(metrics.judgedCount, 4);
  assert.equal(metrics.unjudgedCount, 1);
  assert.equal(metrics.unjudgedAt5, 1);
  assert.equal(metrics.unjudgedAt10, 1);
});

test("no-promotion ambiguity cases omit undefined recall metrics and do not depress ordinary aggregates", () => {
  const noPromotion = evaluateRanking([symbol("src/other.ts", "lookup", 1)], {
    relevant: [],
    forbidden: [selector("src/a.ts", "lookup"), selector("src/b.ts", "lookup")],
    exhaustive: false,
    ambiguous: true,
    expectation: "no-promotion",
  });
  const ordinary = evaluateRanking([symbol("src/target.ts", "target", 1)], {
    relevant: [selector("src/target.ts", "target")],
    exhaustive: false,
  });
  assert.equal(noPromotion.hitAt1, null);
  assert.equal(noPromotion.mrrAt5, null);
  assert.equal(noPromotion.recallAt10, null);
  assert.equal(noPromotion.precisionAt5, undefined);
  assert.equal(noPromotion.ambiguityFalsePromotion, 0);
  assert.equal(noPromotion.ambiguityCaseCount, 1);
  assert.equal(aggregateRankingMetrics([ordinary, noPromotion]).hitAt1, 1);
  assert.equal(aggregateRankingMetrics([ordinary, noPromotion]).ambiguityCaseCount, 1);
});
