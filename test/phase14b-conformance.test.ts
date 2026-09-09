import assert from "node:assert/strict";
import test from "node:test";

import { targetLanguages } from "./helpers/phase14b-language-fixtures.js";
import { loadPhase14bExpectedFixture, normalizeDecision, normalizeDiagnostic, runConcurrentPhase14bFixtures, runPhase14bFixture, type ParallelFixtureResult } from "./helpers/phase14b-conformance.js";

test("all target-language fixtures satisfy the applicable semantic floor", async () => {
  for (const language of targetLanguages) {
    const result = await runPhase14bFixture(language);
    assert.equal(result.floorPassed, true, language);
    assert.deepEqual(result.normalizedEdges, result.expected.normalizedEdges, language);
    assert.deepEqual(result.decisions.map(normalizeDecision), result.expected.decisions, language);
    assert.deepEqual(result.diagnostics.map(normalizeDiagnostic), result.expected.diagnostics, language);
    assert.equal(result.mayBeIncomplete, result.expected.mayBeIncomplete, language);
    assert.equal(result.usedSourceSemanticFallback, false, language);
    for (const decision of result.decisions) {
      if (decision.status === "resolved") {
        assert.ok(decision.strategy, language);
        assert.ok(decision.confidence === "exact" || decision.confidence === "strong", language);
        assert.ok(decision.target, language);
      }
    }
    for (const edge of result.normalizedEdges as Array<Record<string, unknown>>) {
      assert.equal(typeof edge.strategy, "string", language);
      assert.ok(edge.confidence === "exact" || edge.confidence === "strong", language);
      assert.ok(Array.isArray(edge.evidence) && edge.evidence.length > 0 && edge.evidence.length <= 8, language);
    }
  }
});

test("conformance decisions and persisted edge projections are deterministic across cold, warm, and parallel runs", async () => {
  let warmMemoHits = 0;
  for (const language of targetLanguages) {
    const cold = await runPhase14bFixture(language, { memoMode: "cold", parallel: false });
    const coldMemoHits = cold.counters.memoHits;
    const warm = await runPhase14bFixture(language, { memoMode: "warm", parallel: false });
    const projection = (result: typeof cold) => ({
      decisions: result.decisions.map(normalizeDecision),
      edges: result.normalizedEdges,
      diagnostics: result.diagnostics.map(normalizeDiagnostic),
      mayBeIncomplete: result.mayBeIncomplete,
    });
    assert.ok(warm.counters.memoHits >= coldMemoHits, language);
    warmMemoHits += warm.counters.memoHits - coldMemoHits;
    assert.deepEqual(projection(warm), projection(cold), language);
  }
  assert.ok(warmMemoHits > 0, "warm conformance runs must exercise the shared resolver memo cache");
});

test("independent worker resolver jobs overlap and remain deterministically equivalent", async () => {
  const languages = ["typescript", "python"] as const;
  const [first, second] = await Promise.all([
    runConcurrentPhase14bFixtures(languages),
    runConcurrentPhase14bFixtures(languages),
  ]);
  const expected = new Map(await Promise.all(languages.map(async (language) => [language, await loadPhase14bExpectedFixture(language)] as const)));
  const projection = (result: ParallelFixtureResult) => result.projection;
  for (const batch of [first, second]) {
    assert.ok(Math.max(...batch.map((result) => result.startedAt)) < Math.min(...batch.map((result) => result.finishedAt)), "worker resolver jobs must overlap");
    for (const result of batch) {
      const oracle = expected.get(result.language)!;
      assert.deepEqual(result.projection, {
        decisions: oracle.decisions,
        edges: oracle.normalizedEdges,
        diagnostics: oracle.diagnostics,
        mayBeIncomplete: oracle.mayBeIncomplete,
      }, result.language);
    }
  }
  assert.deepEqual(first.map(projection), second.map(projection));
});

test("authoritative expected fixtures are explicit and strict", async () => {
  for (const language of targetLanguages) {
    const expected = await loadPhase14bExpectedFixture(language);
    assert.ok(Array.isArray(expected.normalizedEdges), language);
    assert.ok(Array.isArray(expected.decisions), language);
    assert.ok(Array.isArray(expected.diagnostics), language);
    assert.equal(typeof expected.mayBeIncomplete, "boolean", language);
  }
  await assert.rejects(() => loadPhase14bExpectedFixture("missing-language"), /unknown|expected fixture/i);
});
