import type { AggregateScore, BaselineEntry, CaseScore, GateFailure, ObservedMetrics, QualityPolicy, ResolvedQualityBudget } from "../types.js";

const qualityFailure = (caseId: string | undefined, gate: string, expected: number | boolean, observed: number | boolean, message: string, scope: "case" | "corpus" = "case"): GateFailure => ({
  gate,
  scope,
  ...(caseId ? { caseId } : {}),
  expected,
  observed,
  message,
});

function validateOverride(value: number, field: string): void {
  if (!Number.isFinite(value) || value < 0) throw new Error(`Invalid quality override ${field}: expected a finite non-negative number`);
}

function mergeNumberFields<T extends Record<string, number>>(defaults: T, overrides: Partial<T> | undefined, group: string): T {
  const result = { ...defaults };
  for (const [field, value] of Object.entries(overrides ?? {})) {
    validateOverride(value, `${group}.${field}`);
    result[field as keyof T] = value as T[keyof T];
  }
  return result;
}

export function resolveQualityBudget(policy: QualityPolicy, entry: BaselineEntry): ResolvedQualityBudget {
  const aggregate = mergeNumberFields(policy.aggregate, entry.qualityOverrides?.aggregate, "aggregate");
  const catastrophicOverrides = entry.qualityOverrides?.catastrophic;
  const catastrophic = mergeNumberFields({
    maxEstimatedTokensMultiplier: policy.catastrophic.maxEstimatedTokensMultiplier,
    maxReturnedBytesMultiplier: policy.catastrophic.maxReturnedBytesMultiplier,
  }, {
    ...(catastrophicOverrides?.maxEstimatedTokensMultiplier === undefined ? {} : { maxEstimatedTokensMultiplier: catastrophicOverrides.maxEstimatedTokensMultiplier }),
    ...(catastrophicOverrides?.maxReturnedBytesMultiplier === undefined ? {} : { maxReturnedBytesMultiplier: catastrophicOverrides.maxReturnedBytesMultiplier }),
  }, "catastrophic");
  return {
    aggregate,
    catastrophic: {
      maxEstimatedTokens: entry.estimatedTokens * catastrophic.maxEstimatedTokensMultiplier,
      maxReturnedBytes: entry.returnedBytes * catastrophic.maxReturnedBytesMultiplier,
      maxSelectedItems: entry.selectedItems + Math.max(3, entry.selectedItems),
      requiredTargetsMayDisappear: catastrophicOverrides?.requiredTargetsMayDisappear ?? policy.catastrophic.requiredTargetsMayDisappear,
    },
  };
}

export function scoreQuality(input: { metrics: ObservedMetrics; baseline: BaselineEntry; policy: QualityPolicy }): readonly GateFailure[] {
  const { metrics, baseline } = input;
  const budget = resolveQualityBudget(input.policy, baseline);
  const failures: GateFailure[] = [];
  if (metrics.estimatedTokens > budget.catastrophic.maxEstimatedTokens) failures.push(qualityFailure(baseline.caseId, "quality.catastrophic.estimated_tokens", budget.catastrophic.maxEstimatedTokens, metrics.estimatedTokens, "Estimated tokens exceed the per-case catastrophic ceiling"));
  if (metrics.returnedBytes > budget.catastrophic.maxReturnedBytes) failures.push(qualityFailure(baseline.caseId, "quality.catastrophic.returned_bytes", budget.catastrophic.maxReturnedBytes, metrics.returnedBytes, "Returned bytes exceed the per-case catastrophic ceiling"));
  if (metrics.selectedItems > budget.catastrophic.maxSelectedItems) failures.push(qualityFailure(baseline.caseId, "quality.catastrophic.selected_items", budget.catastrophic.maxSelectedItems, metrics.selectedItems, "Selected items exceed the per-case catastrophic ceiling"));
  if (!budget.catastrophic.requiredTargetsMayDisappear && metrics.requiredHitRate < 1) failures.push(qualityFailure(baseline.caseId, "quality.catastrophic.required_targets", 1, metrics.requiredHitRate, "Required targets may not disappear from the selected set"));
  return failures;
}

function sum(scores: readonly CaseScore[], field: keyof Pick<ObservedMetrics, "selectedItems" | "estimatedTokens" | "returnedBytes" | "fullItems" | "deltaItems" | "unchangedItems" | "rehydratedItems" | "requestedBytes" | "savedBytes" | "bodyResendCount">): number {
  return scores.reduce((total, score) => total + score.metrics[field], 0);
}

function average(scores: readonly CaseScore[], field: "requiredHitRate" | "supportingHitRate"): number {
  return scores.reduce((total, score) => total + score.metrics[field], 0) / scores.length;
}

function aggregateMetrics(scores: readonly CaseScore[]): ObservedMetrics {
  const first = scores[0]?.metrics;
  if (!first) throw new Error("Cannot aggregate an empty quality score set");
  return {
    ...first,
    selectedItems: sum(scores, "selectedItems"),
    estimatedTokens: sum(scores, "estimatedTokens"),
    returnedBytes: sum(scores, "returnedBytes"),
    requiredHitRate: average(scores, "requiredHitRate"),
    supportingHitRate: average(scores, "supportingHitRate"),
    contextPrecision: scores.reduce((total, score) => total + score.metrics.contextPrecision, 0) / scores.length,
    fullItems: sum(scores, "fullItems"),
    deltaItems: sum(scores, "deltaItems"),
    unchangedItems: sum(scores, "unchangedItems"),
    rehydratedItems: sum(scores, "rehydratedItems"),
    requestedBytes: sum(scores, "requestedBytes"),
    savedBytes: sum(scores, "savedBytes"),
    bodyResendCount: sum(scores, "bodyResendCount"),
    reuseRate: scores.reduce((total, score) => total + score.metrics.reuseRate, 0) / scores.length,
    timingsMs: { indexLoad: 0, compile: 0, lifecycleStart: 0, refresh: 0 },
  };
}

type AggregatedBaseline = BaselineEntry & { entries: readonly BaselineEntry[] };

function aggregateBaseline(scores: readonly CaseScore[], baselines: ReadonlyMap<string, BaselineEntry>): AggregatedBaseline {
  const entries = scores.map((score) => {
    const baseline = baselines.get(score.caseId);
    if (!baseline) throw new Error(`Missing baseline for case ${score.caseId}`);
    return baseline;
  });
  return {
    caseId: "aggregate",
    selectedItems: entries.reduce((total, entry) => total + entry.selectedItems, 0),
    estimatedTokens: entries.reduce((total, entry) => total + entry.estimatedTokens, 0),
    returnedBytes: entries.reduce((total, entry) => total + entry.returnedBytes, 0),
    requiredHitRate: entries.reduce((total, entry) => total + entry.requiredHitRate, 0) / entries.length,
    supportingHitRate: entries.reduce((total, entry) => total + entry.supportingHitRate, 0) / entries.length,
    entries,
  };
}

export function aggregateScores(scores: readonly CaseScore[], baselines: ReadonlyMap<string, BaselineEntry>, policy: QualityPolicy): AggregateScore {
  const metrics = aggregateMetrics(scores);
  const baseline = aggregateBaseline(scores, baselines);
  const failures: GateFailure[] = scores.flatMap((score) => [...score.failures, ...scoreQuality({ metrics: score.metrics, baseline: baselines.get(score.caseId)!, policy })]);
  const budgets = baseline.entries.map((entry) => resolveQualityBudget(policy, entry));
  const allowedIncrease = (field: "selectedItems" | "estimatedTokens" | "returnedBytes", budgetField: "maxSelectedItemsIncreasePct" | "maxEstimatedTokensIncreasePct" | "maxReturnedBytesIncreasePct") => baseline.entries.reduce((total, entry, index) => total + entry[field] * (1 + budgets[index].aggregate[budgetField] / 100), 0);
  const increase = (observed: number, allowed: number, field: string) => {
    if (observed > allowed) failures.push(qualityFailure(undefined, `quality.aggregate.${field}`, allowed, observed, `Aggregate ${field} exceeds the reviewed quality budget`, "corpus"));
  };
  increase(metrics.estimatedTokens, allowedIncrease("estimatedTokens", "maxEstimatedTokensIncreasePct"), "estimated_tokens");
  increase(metrics.returnedBytes, allowedIncrease("returnedBytes", "maxReturnedBytesIncreasePct"), "returned_bytes");
  increase(metrics.selectedItems, allowedIncrease("selectedItems", "maxSelectedItemsIncreasePct"), "selected_items");
  const requiredFloor = budgets.reduce((total, budget, index) => total + baseline.entries[index].requiredHitRate - budget.aggregate.maxRequiredHitRateDecreasePp / 100, 0) / budgets.length;
  const supportingFloor = budgets.reduce((total, budget, index) => total + baseline.entries[index].supportingHitRate - budget.aggregate.maxSupportingHitRateDecreasePp / 100, 0) / budgets.length;
  if (metrics.requiredHitRate < requiredFloor) failures.push(qualityFailure(undefined, "quality.aggregate.required_hit_rate", requiredFloor, metrics.requiredHitRate, "Aggregate required hit rate is below the reviewed quality budget", "corpus"));
  if (metrics.supportingHitRate < supportingFloor) failures.push(qualityFailure(undefined, "quality.aggregate.supporting_hit_rate", supportingFloor, metrics.supportingHitRate, "Aggregate supporting hit rate is below the reviewed quality budget", "corpus"));
  return { metrics, failures, aggregateQuality: failures.length === 0 };
}
