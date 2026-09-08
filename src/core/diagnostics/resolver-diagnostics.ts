import type {
  ResolverDiagnostic,
  ResolverDiagnosticKind,
} from "./coverage-diagnostics.types.js";
import type { LanguageId, ResolutionDecision } from "../graph/resolution.types.js";

export const MAX_DIAGNOSTIC_REASON_LENGTH = 256;

function diagnosticKind(decision: ResolutionDecision): ResolverDiagnosticKind {
  switch (decision.status) {
    case "budget_exhausted":
      return "budgetExhausted";
    case "weak_evidence_dropped":
      return "weakEvidenceDropped";
    case "candidate_overflow":
      return "candidateOverflow";
    default:
      return decision.status;
  }
}

export function diagnosticFor(
  decision: ResolutionDecision,
  file: string,
  language: LanguageId,
): ResolverDiagnostic {
  const reason = "reason" in decision
    ? decision.reason.slice(0, MAX_DIAGNOSTIC_REASON_LENGTH)
    : undefined;
  return {
    kind: diagnosticKind(decision),
    language,
    file,
    strategy: decision.strategy,
    edgeKind: decision.edgeKind,
    count: 1,
    reason,
  };
}
