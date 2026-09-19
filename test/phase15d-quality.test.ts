import assert from "node:assert/strict";
import test from "node:test";

import { aggregateScores, resolveQualityBudget, scoreQuality } from "../eval/context/runner/aggregate.js";
import type { BaselineEntry, CaseScore, GateFailure, ObservedMetrics, QualityPolicy } from "../eval/context/types.js";

const policy: QualityPolicy = {
  policyVersion: "context-eval-policy-v1",
  aggregate: {
    maxEstimatedTokensIncreasePct: 10,
    maxReturnedBytesIncreasePct: 10,
    maxSelectedItemsIncreasePct: 10,
    maxRequiredHitRateDecreasePp: 0,
    maxSupportingHitRateDecreasePp: 5,
  },
  catastrophic: {
    maxEstimatedTokensMultiplier: 2,
    maxReturnedBytesMultiplier: 2,
    selectedItemsFormula: "baselineSelectedItems + max(3, baselineSelectedItems)",
    requiredTargetsMayDisappear: false,
  },
};

const baseline: BaselineEntry = {
  caseId: "case-one",
  selectedItems: 3,
  estimatedTokens: 10,
  returnedBytes: 20,
  requiredHitRate: 1,
  supportingHitRate: 1,
};

function metrics(overrides: Partial<ObservedMetrics> = {}): ObservedMetrics {
  return {
    selectedItems: 3,
    estimatedTokens: 10,
    returnedBytes: 20,
    requiredHitRate: 1,
    supportingHitRate: 1,
    contextPrecision: 1,
    fullItems: 1,
    deltaItems: 0,
    unchangedItems: 0,
    rehydratedItems: 0,
    requestedBytes: 20,
    savedBytes: 0,
    reuseRate: 0,
    bodyResendCount: 0,
    timingsMs: { indexLoad: 0, compile: 0, lifecycleStart: 0, refresh: 0 },
    ...overrides,
  };
}

function score(caseId: string, value: ObservedMetrics, failures: readonly GateFailure[] = []): CaseScore {
  return {
    caseId,
    metrics: value,
    failures,
    gates: { correctness: true, determinism: true, reconstruction: true, authorityUncertainty: true, isolation: "unknown", catastrophicQuality: true },
  };
}

test("resolves policy defaults, preserves baseline metrics as comparison data, and applies field-level overrides", () => {
  const resolved = resolveQualityBudget({ ...policy, aggregate: { ...policy.aggregate, maxSelectedItemsIncreasePct: 99 } }, {
    ...baseline,
    selectedItems: 8,
    qualityOverrides: { aggregate: { maxSelectedItemsIncreasePct: 7 }, catastrophic: { maxReturnedBytesMultiplier: 3 } },
  });

  assert.equal(resolved.aggregate.maxSelectedItemsIncreasePct, 7);
  assert.equal(resolved.aggregate.maxEstimatedTokensIncreasePct, 10);
  assert.equal(resolved.catastrophic.maxEstimatedTokens, 20);
  assert.equal(resolved.catastrophic.maxReturnedBytes, 60);
  assert.equal(resolved.catastrophic.maxSelectedItems, 16);
});

test("enforces exact catastrophic ceilings and rejects non-finite overrides", () => {
  assert.deepEqual(scoreQuality({ metrics: metrics({ selectedItems: 6, estimatedTokens: 20, returnedBytes: 40 }), baseline, policy }), []);
  assert.deepEqual(scoreQuality({ metrics: metrics({ selectedItems: 7 }), baseline, policy }).map(({ gate }) => gate), ["quality.catastrophic.selected_items"]);
  assert.deepEqual(scoreQuality({ metrics: metrics({ estimatedTokens: 21, returnedBytes: 41 }), baseline, policy }).map(({ gate }) => gate), ["quality.catastrophic.estimated_tokens", "quality.catastrophic.returned_bytes"]);
  assert.throws(() => resolveQualityBudget(policy, { ...baseline, qualityOverrides: { aggregate: { maxSelectedItemsIncreasePct: Number.NaN } } }));
});

test("applies aggregate percentage and hit-rate budgets at their boundaries", () => {
  const scores = [score("case-one", metrics({ selectedItems: 3, estimatedTokens: 11, returnedBytes: 22, requiredHitRate: 1, supportingHitRate: 0.95 }))];
  const result = aggregateScores(scores, new Map([[baseline.caseId, baseline]]), policy);
  assert.equal(result.aggregateQuality, true);
  assert.deepEqual(result.failures, []);

  const failed = aggregateScores([score("case-one", metrics({ selectedItems: 4, estimatedTokens: 12, returnedBytes: 23, requiredHitRate: 0.99, supportingHitRate: 0.94 }))], new Map([[baseline.caseId, baseline]]), policy);
  assert.deepEqual(failed.failures.map(({ gate }) => gate), [
    "quality.catastrophic.required_targets",
    "quality.aggregate.estimated_tokens",
    "quality.aggregate.returned_bytes",
    "quality.aggregate.selected_items",
    "quality.aggregate.required_hit_rate",
    "quality.aggregate.supporting_hit_rate",
  ]);
});

test("changes the aggregate outcome only when the baseline entry override is honored", () => {
  const observed = score("case-one", metrics({ estimatedTokens: 15 }));
  const withoutOverride = aggregateScores([observed], new Map([[baseline.caseId, baseline]]), policy);
  const withOverride = aggregateScores([observed], new Map([[baseline.caseId, {
    ...baseline,
    qualityOverrides: { aggregate: { maxEstimatedTokensIncreasePct: 100 } },
  }]]), policy);

  assert.deepEqual(withoutOverride.failures.map(({ gate }) => gate), ["quality.aggregate.estimated_tokens"]);
  assert.deepEqual(withOverride.failures, []);
  assert.equal(withOverride.aggregateQuality, true);
});

test("requires a baseline for every score and preserves correctness failures", () => {
  assert.throws(() => aggregateScores([score("missing", metrics())], new Map(), policy), /Missing baseline/);
  const correctnessFailure = { gate: "correctness.required_hit_rate", scope: "case" as const, caseId: "case-one", observed: 0, expected: 1, message: "required subject missing" };
  const result = aggregateScores([score("case-one", metrics(), [correctnessFailure])], new Map([[baseline.caseId, baseline]]), policy);
  assert.equal(result.aggregateQuality, false);
  assert.equal(result.failures.some(({ gate }) => gate === "correctness.required_hit_rate"), true);
});
