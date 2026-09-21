export const RESOLUTION_METHODS = [
  "same_file",
  "import_binding",
  "this_receiver",
  "constructor_type",
  "parameter_type",
  "field_type",
  "inheritance",
] as const;

export type ResolutionMethod = (typeof RESOLUTION_METHODS)[number];

export type ResolutionConfidence = "exact" | "strong" | "weak";

export type AcceptedResolutionConfidence = Exclude<ResolutionConfidence, "weak">;

export type LanguageId = import("./parsers/types.js").SupportedLanguage;

export type CompactEvidence = {
  kind: string;
  sourceUnit: string;
  startLine: number;
  endLine: number;
  evidenceId?: string;
};

export type EdgeResolutionProvenance = {
  strategy: string;
  confidence: AcceptedResolutionConfidence;
  evidence: readonly CompactEvidence[];
  resolutionVersion: string;
  sourceLogicalIdentity: string;
  targetLogicalIdentity: string;
};

export type ResolutionEvidenceKind = "EXTRACTED" | "INFERRED" | "AMBIGUOUS";

export type ResolutionLocation = {
  file: string;
  line: number;
};

export type ResolutionEvidence = {
  evidenceKind: ResolutionEvidenceKind;
  resolutionMethod?: ResolutionMethod;
  source: ResolutionLocation;
  detail?: string;
};

type ResolutionDecisionBase = {
  language: LanguageId;
  edgeKind?: import("./types.js").GraphEdgeType;
  strategy?: string;
};

export type ResolutionDecision =
  | (ResolutionDecisionBase & {
      status: "resolved";
      confidence: AcceptedResolutionConfidence;
      targetLogicalIdentity: string;
    })
  | (ResolutionDecisionBase & {
      status: "ambiguous" | "unknown" | "unsupported" | "budget_exhausted" | "weak_evidence_dropped" | "candidate_overflow";
      reason: string;
    });

export type ResolutionResult =
  | {
      kind: "resolved";
      targetSymbolId: string;
      candidateCount: number;
      evidence: ResolutionEvidence[];
      resolutionMethod: ResolutionMethod;
      confidence: number;
      source: ResolutionLocation;
    }
  | {
      kind: "ambiguous";
      candidates: string[];
      evidence: ResolutionEvidence[];
      ambiguityReason: string;
      source: ResolutionLocation;
    }
  | {
      kind: "unresolved";
      evidence: ResolutionEvidence[];
      reason: string;
      source: ResolutionLocation;
      unsupportedDynamic?: boolean;
    };

export type ResolutionDiagnostic = Extract<
  ResolutionResult,
  { kind: "ambiguous" | "unresolved" }
>;

export type ResolutionCoverage = {
  calls: number;
  resolvedCalls: number;
  unresolvedCalls: number;
  ambiguousCalls: number;
  extends: number;
  resolvedExtends: number;
  unresolvedExtends: number;
  ambiguousExtends: number;
  parserErrors: number;
  unsupportedDynamic: number;
  mayBeIncomplete: boolean;
};

export type ResolutionBatch = {
  edges: import("./types.js").GraphEdge[];
  results: ResolutionResult[];
  coverage: ResolutionCoverage;
};

export type GraphResolutionFile = {
  coverage: ResolutionCoverage;
  diagnostics: ResolutionDiagnostic[];
};

export function emptyResolutionCoverage(): ResolutionCoverage {
  return {
    calls: 0,
    resolvedCalls: 0,
    unresolvedCalls: 0,
    ambiguousCalls: 0,
    extends: 0,
    resolvedExtends: 0,
    unresolvedExtends: 0,
    ambiguousExtends: 0,
    parserErrors: 0,
    unsupportedDynamic: 0,
    mayBeIncomplete: false,
  };
}

export function mergeResolutionCoverage(
  left: ResolutionCoverage,
  right: ResolutionCoverage,
): ResolutionCoverage {
  return {
    calls: left.calls + right.calls,
    resolvedCalls: left.resolvedCalls + right.resolvedCalls,
    unresolvedCalls: left.unresolvedCalls + right.unresolvedCalls,
    ambiguousCalls: left.ambiguousCalls + right.ambiguousCalls,
    extends: left.extends + right.extends,
    resolvedExtends: left.resolvedExtends + right.resolvedExtends,
    unresolvedExtends: left.unresolvedExtends + right.unresolvedExtends,
    ambiguousExtends: left.ambiguousExtends + right.ambiguousExtends,
    parserErrors: left.parserErrors + right.parserErrors,
    unsupportedDynamic: left.unsupportedDynamic + right.unsupportedDynamic,
    mayBeIncomplete: left.mayBeIncomplete || right.mayBeIncomplete,
  };
}
