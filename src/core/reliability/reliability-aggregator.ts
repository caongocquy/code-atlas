import { normalizeContributions, normalizeEvidenceRefs } from "./reliability-normalize.js";
import type {
  CoverageSummary,
  DiagnosticRef,
  ReliabilityContribution,
  ReliabilityProjection,
  ReliabilityScope,
} from "./reliability.types.js";

const OUTCOME_PRIORITY: Record<ReliabilityContribution["outcome"], number> = {
  accepted: 0,
  unsupported: 1,
  unknown: 2,
  budget_exhausted: 3,
  ambiguous: 4,
};

function outputOutcome(values: readonly ReliabilityContribution[]): ReliabilityContribution["outcome"] {
  return values.reduce(
    (current, value) => OUTCOME_PRIORITY[value.outcome] > OUTCOME_PRIORITY[current] ? value.outcome : current,
    "accepted" as ReliabilityContribution["outcome"],
  );
}

function sameScope(contribution: ReliabilityContribution, scope: ReliabilityScope): boolean {
  return contribution.scope.scopeKey === scope.scopeKey;
}

export function aggregateCoverage(contributions: readonly ReliabilityContribution[]): CoverageSummary {
  const normalized = normalizeContributions(contributions);
  const groups = new Map<string, ReliabilityContribution[]>();
  for (const contribution of normalized) {
    const group = groups.get(contribution.outputKey) ?? [];
    group.push(contribution);
    groups.set(contribution.outputKey, group);
  }
  const summary: CoverageSummary = {
    applicable: normalized.filter((item) => item.coverage.applicable).length,
    supported: normalized.filter((item) => item.coverage.supported).length,
    attempted: normalized.filter((item) => item.coverage.attempted).length,
    resolved: 0,
    ambiguous: 0,
    unknown: 0,
    unsupported: 0,
    budgetExhausted: 0,
  };
  for (const group of groups.values()) {
    const outcome = outputOutcome(group);
    if (outcome === "accepted") summary.resolved += 1;
    else if (outcome === "ambiguous") summary.ambiguous += 1;
    else if (outcome === "unknown") summary.unknown += 1;
    else if (outcome === "unsupported") summary.unsupported += 1;
    else summary.budgetExhausted += 1;
  }
  return summary;
}

export function aggregateDiagnosticRefs(contributions: readonly ReliabilityContribution[]): readonly DiagnosticRef[] {
  const values = new Map<string, DiagnosticRef>();
  for (const contribution of normalizeContributions(contributions)) {
    for (const diagnostic of contribution.diagnostics) values.set(JSON.stringify(diagnostic), diagnostic);
  }
  return [...values.values()].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

export function aggregateReliability(
  contributions: readonly ReliabilityContribution[],
  scope: ReliabilityScope,
): ReliabilityProjection {
  const scoped = normalizeContributions(contributions).filter((item) => sameScope(item, scope));
  const groups = new Map<string, ReliabilityContribution[]>();
  for (const contribution of scoped) {
    const group = groups.get(contribution.outputKey) ?? [];
    group.push(contribution);
    groups.set(contribution.outputKey, group);
  }
  const outcomes = [...groups.values()].map(outputOutcome);
  const outcome = outcomes.reduce(
    (current, value) => OUTCOME_PRIORITY[value] > OUTCOME_PRIORITY[current] ? value : current,
    "accepted" as ReliabilityContribution["outcome"],
  );
  const stale = scoped.some((item) => item.stale);
  const complete = scoped.length > 0 && scoped.every((item) => item.complete && !item.stale);
  const coverage = aggregateCoverage(scoped);
  const diagnostics = aggregateDiagnosticRefs(scoped);
  const evidence = normalizeEvidenceRefs(scoped.flatMap((item) => item.evidence));
  const authoritative = complete && !stale && outcome === "accepted";
  return {
    scope,
    outcome,
    complete,
    stale,
    authoritative,
    authoritativeNegative: authoritative && coverage.ambiguous === 0 && coverage.unknown === 0 && coverage.unsupported === 0 && coverage.budgetExhausted === 0,
    coverage,
    diagnosticCodes: [...new Set(diagnostics.map((item) => item.code))].sort(),
    evidenceSummary: {
      total: evidence.length,
      origins: [...new Set(evidence.map((item) => item.origin))].sort(),
    },
  };
}
