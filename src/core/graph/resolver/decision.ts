import type { ParsedFactsBlob } from "../../facts/facts.types.js";
import type { GenerationResolverContext } from "./generation-context.js";
import { symbolIdentityKey, type ResolutionSiteIdentity, type SourceUnitIdentity, type SymbolIdentity } from "./identities.js";
import type { TypeEnvironment } from "./type-environment.js";
import type {
  AmbiguityReason,
  BudgetReason,
  EvidenceId,
  LanguageId,
  ResolutionStrategyId,
  SemanticEvidenceBatch,
  UnknownReason,
  UnsupportedReason,
} from "./types.js";

export type { ResolutionSiteIdentity, SourceUnitIdentity, SymbolIdentity };
export type ResolvableEdgeKind = "calls" | "references" | "extends" | "implements";

export type ResolutionDecisionBase = {
  site: ResolutionSiteIdentity;
  language: LanguageId;
  sourceUnit: SourceUnitIdentity;
  edgeKind: ResolvableEdgeKind;
  evidenceIds: readonly EvidenceId[];
  attemptedStrategies: readonly ResolutionStrategyId[];
  resolutionVersion: string;
};

export type ResolutionDecision = ResolutionDecisionBase & (
  | { status: "resolved"; target: SymbolIdentity; strategy: ResolutionStrategyId; confidence: "exact" | "strong" }
  | { status: "ambiguous"; candidates: readonly SymbolIdentity[]; reason: AmbiguityReason }
  | { status: "unknown"; reason: UnknownReason }
  | { status: "unsupported"; reason: UnsupportedReason }
  | { status: "budget_exhausted"; reason: BudgetReason }
);

export type ResolutionCandidate = {
  target: SymbolIdentity;
  strategy: ResolutionStrategyId;
  confidence: "exact" | "strong" | "weak";
  evidenceIds: readonly EvidenceId[];
};

export type ResolverInput = {
  facts: ParsedFactsBlob;
  evidence: SemanticEvidenceBatch;
  environment: TypeEnvironment;
  context: GenerationResolverContext;
};

const evidenceIds = (candidates: readonly ResolutionCandidate[]): readonly EvidenceId[] =>
  [...new Set(candidates.flatMap((candidate) => candidate.evidenceIds))].sort();

function edgeKind(facts: ParsedFactsBlob, site: ResolutionSiteIdentity): ResolvableEdgeKind {
  if (facts.implementations?.some((item) => item.localId === site.localId)) return "implements";
  if (facts.inheritances?.some((item) => item.localId === site.localId)) return "extends";
  if (facts.callSites?.some((item) => item.localId === site.localId)) return "calls";
  return "references";
}

function base(input: ResolverInput, site: ResolutionSiteIdentity, attemptedStrategies: readonly ResolutionStrategyId[], candidates: readonly ResolutionCandidate[]): ResolutionDecisionBase {
  return {
    site,
    language: input.facts.language ?? site.sourceUnit.language,
    sourceUnit: site.sourceUnit,
    edgeKind: edgeKind(input.facts, site),
    evidenceIds: evidenceIds(candidates),
    attemptedStrategies,
    resolutionVersion: input.context.resolutionVersion,
  };
}

function unsupportedLanguage(input: ResolverInput): UnsupportedReason | undefined {
  const hasAdapter = input.context.languageRegistry.some((adapter) => adapter.languages.includes(input.facts.language));
  const diagnostic = input.evidence.diagnostics.find((item) => item.code === "language_capability_unsupported");
  return diagnostic || !hasAdapter ? "language_capability_unsupported" : undefined;
}

export function uniqueTargetGate(
  input: ResolverInput,
  site: ResolutionSiteIdentity,
  candidates: readonly ResolutionCandidate[],
  attemptedStrategies: readonly ResolutionStrategyId[],
): ResolutionDecision {
  const accepted = candidates.filter((candidate) => candidate.confidence !== "weak");
  const grouped = new Map<string, ResolutionCandidate>();
  for (const candidate of accepted) {
    const key = symbolIdentityKey(candidate.target);
    const existing = grouped.get(key);
    if (!existing || (existing.confidence === "strong" && candidate.confidence === "exact")) grouped.set(key, candidate);
  }
  const ordered = [...grouped.values()].sort((left, right) => symbolIdentityKey(left.target).localeCompare(symbolIdentityKey(right.target)));
  const decisionBase = base(input, site, attemptedStrategies, candidates);
  if (ordered.length === 1) {
    const candidate = ordered[0];
    return { ...decisionBase, status: "resolved", target: candidate.target, strategy: candidate.strategy, confidence: candidate.confidence as "exact" | "strong" };
  }
  if (ordered.length > 1) {
    const decision: ResolutionDecision = { ...decisionBase, status: "ambiguous", candidates: ordered.map((candidate) => candidate.target), reason: "multiple_candidates" };
    input.context.diagnostics.add({ site, status: "ambiguous", reason: decision.reason });
    return decision;
  }
  const weak = candidates.some((candidate) => candidate.confidence === "weak");
  const reason = input.context.budget.remaining("candidateExpansions") === 0
    ? "budget_exhausted"
    : weak ? "weak_only" : unsupportedLanguage(input) ? "unsupported" : "unknown";
  if (reason === "budget_exhausted") {
    input.context.diagnostics.add({ site, status: "budget_exhausted", reason: "candidate_expansion_limit" });
    return { ...decisionBase, status: "budget_exhausted", reason: "candidate_expansion_limit" };
  }
  if (reason === "unsupported") {
    input.context.diagnostics.add({ site, status: "unsupported", reason: "language_capability_unsupported" });
    return { ...decisionBase, status: "unsupported", reason: "language_capability_unsupported" };
  }
  input.context.diagnostics.add({ site, status: "unknown", reason });
  return { ...decisionBase, status: "unknown", reason: reason as UnknownReason };
}
