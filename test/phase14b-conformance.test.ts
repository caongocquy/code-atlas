import assert from "node:assert/strict";
import test from "node:test";

import { targetLanguages } from "./helpers/phase14b-language-fixtures.js";
import { runPhase14bFixture } from "./helpers/phase14b-conformance.js";

test("all target-language fixtures satisfy the applicable semantic floor", async () => {
  for (const language of targetLanguages) {
    const result = await runPhase14bFixture(language);
    assert.equal(result.floorPassed, true, language);
    assert.deepEqual(result.normalizedEdges.map((edge) => ({ type: (edge as { type: unknown }).type })), result.expected.normalizedEdges, language);
    assert.deepEqual(result.decisions.map((decision) => ({ status: decision.status })), result.expected.decisions, language);
    assert.equal(result.diagnostics.length >= result.decisions.length, true, language);
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
      assert.ok(Array.isArray(edge.evidenceKinds) && edge.evidenceKinds.length <= 8, language);
    }
  }
});

test("conformance decisions and persisted edge projections are deterministic across cold, warm, and parallel runs", async () => {
  for (const language of targetLanguages) {
    const cold = await runPhase14bFixture(language, { memoMode: "cold", parallel: false });
    const warm = await runPhase14bFixture(language, { memoMode: "warm", parallel: false });
    const parallel = await runPhase14bFixture(language, { memoMode: "cold", parallel: true });
    const projection = (result: typeof cold) => ({
      decisions: result.decisions.map((decision) => ({ status: decision.status, strategy: decision.strategy, confidence: "confidence" in decision ? decision.confidence : undefined, reason: "reason" in decision ? decision.reason : undefined })),
      edges: result.normalizedEdges,
      diagnostics: result.diagnostics,
      mayBeIncomplete: result.mayBeIncomplete,
    });
    assert.deepEqual(projection(warm), projection(cold), language);
    assert.deepEqual(projection(parallel), projection(cold), language);
  }
});
