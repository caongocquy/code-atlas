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

function mergeCandidates(candidates: readonly ResolutionCandidate[]): readonly ResolutionCandidate[] {
  const merged = new Map<string, ResolutionCandidate>();
  for (const candidate of candidates) {
    const key = symbolIdentityKey(candidate.target);
    const current = merged.get(key);
    if (!current) {
      merged.set(key, { ...candidate, evidenceIds: [...new Set(candidate.evidenceIds)].sort() });
      continue;
    }
    const confidence = current.confidence === "exact" || candidate.confidence === "exact"
      ? "exact"
      : current.confidence === "strong" || candidate.confidence === "strong" ? "strong" : "weak";
    merged.set(key, {
      ...current,
      confidence,
      strategy: current.confidence === "exact" || candidate.confidence !== "exact" ? current.strategy : candidate.strategy,
      evidenceIds: [...new Set([...current.evidenceIds, ...candidate.evidenceIds])].sort(),
    });
  }
  return [...merged.values()].sort((left, right) => symbolIdentityKey(left.target).localeCompare(symbolIdentityKey(right.target)));
}

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

function unsupportedLanguage(input: ResolverInput, attemptedStrategies: readonly ResolutionStrategyId[]): UnsupportedReason | undefined {
  const adapters = input.context.languageRegistry.filter((adapter) => adapter.languages.includes(input.facts.language));
  const diagnostic = input.evidence.diagnostics.find((item) => item.code === "language_capability_unsupported");
  if (diagnostic || adapters.length === 0) return "language_capability_unsupported";
  const unsupportedStrategies = new Set(input.context.diagnostics.snapshot()
    .filter((event) => event.status === "unsupported" && event.strategy)
    .map((event) => event.strategy));
  return attemptedStrategies.length > 0 && attemptedStrategies.every((strategy) => unsupportedStrategies.has(strategy))
    ? "language_capability_unsupported"
    : undefined;
}

function budgetReason(input: ResolverInput): BudgetReason | undefined {
  const mapping: Readonly<Record<string, BudgetReason>> = {
    candidateExpansions: "candidate_expansion_limit",
    bindingHops: "binding_hop_limit",
    returnDepth: "return_depth_limit",
    inheritanceDepth: "inheritance_depth_limit",
    memberCandidates: "member_candidate_limit",
    expressionNodes: "expression_node_limit",
    propagationRounds: "propagation_round_limit",
  };
  return input.context.budget.failedOperations().map((kind) => mapping[kind]).find(Boolean);
}

function semanticUncertainty(input: ResolverInput): { status: "unknown"; reason: UnknownReason } | { status: "unsupported"; reason: UnsupportedReason } | undefined {
  const codes = input.evidence.diagnostics.map((diagnostic) => diagnostic.code);
  const unsupported = codes.find((code): code is UnsupportedReason => [
    "language_capability_unsupported", "compiler_semantics_required", "framework_semantics_required", "preprocessor_semantics_required",
  ].includes(code as UnsupportedReason));
  if (unsupported) return { status: "unsupported", reason: unsupported };
  if (codes.some((code) => code === "parse_uncertain" || code === "parse_error" || code === "semantic_parse_error")) return { status: "unknown", reason: "insufficient_evidence" };
  return undefined;
}

export function uniqueTargetGate(
  input: ResolverInput,
  site: ResolutionSiteIdentity,
  candidates: readonly ResolutionCandidate[],
  attemptedStrategies: readonly ResolutionStrategyId[],
): ResolutionDecision {
  const merged = mergeCandidates(candidates);
  const accepted = merged.filter((candidate) => candidate.confidence !== "weak");
  const ordered = accepted;
  const decisionBase = base(input, site, attemptedStrategies, merged);
  const uncertainty = semanticUncertainty(input);
  if (uncertainty) {
    input.context.diagnostics.add({ site, status: uncertainty.status, reason: uncertainty.reason });
    return { ...decisionBase, ...uncertainty };
  }
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
  const exhausted = budgetReason(input);
  const reason = exhausted ? "budget_exhausted" : weak ? "weak_only" : unsupportedLanguage(input, attemptedStrategies) ? "unsupported" : "unknown";
  if (reason === "budget_exhausted" && exhausted) {
    input.context.diagnostics.add({ site, status: "budget_exhausted", reason: exhausted });
    return { ...decisionBase, status: "budget_exhausted", reason: exhausted };
  }
  if (reason === "unsupported") {
    input.context.diagnostics.add({ site, status: "unsupported", reason: "language_capability_unsupported" });
    return { ...decisionBase, status: "unsupported", reason: "language_capability_unsupported" };
  }
  input.context.diagnostics.add({ site, status: "unknown", reason });
  return { ...decisionBase, status: "unknown", reason: reason as UnknownReason };
}
