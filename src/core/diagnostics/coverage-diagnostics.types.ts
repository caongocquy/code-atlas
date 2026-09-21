import type { LanguageId } from "../graph/resolution.types.js";
import type { GraphEdgeType } from "../graph/types.js";
import type { ResolutionCoverage, ResolutionDiagnostic } from "../graph/resolution.types.js";
import type { CapabilityState } from "../../storage/atlas/atlas.types.js";
import type { ChangedFile } from "../change/change.types.js";
import type { SymbolReference } from "../change/test-intelligence.types.js";

export type ResolverDiagnosticKind =
  | "resolved"
  | "ambiguous"
  | "unknown"
  | "unsupported"
  | "budgetExhausted"
  | "weakEvidenceDropped"
  | "candidateOverflow";

export type ResolverDiagnostic = {
  kind: ResolverDiagnosticKind;
  language: LanguageId;
  file: string;
  strategy?: string;
  edgeKind?: GraphEdgeType;
  count: number;
  reason?: string;
};

export type CoverageGapKind =
  | "dynamic_dispatch"
  | "ambiguous_target"
  | "missing_caller_context"
  | "broken_internal_import"
  | "parser_error"
  | "unsupported_construct"
  | "unmapped_change_range"
  | "missing_baseline"
  | "binary_change"
  | "truncated_analysis"
  | "stale_index"
  | "not_indexed"
  | "ambiguous_architecture_membership";

export type CoverageGap = {
  kind: CoverageGapKind;
  count: number;
  files?: string[];
  symbols?: SymbolReference[];
  details?: string[];
};

export type CoverageMetric = {
  name: string;
  resolved: number;
  total: number;
  ratio: number;
};

export type VerificationTarget = {
  file: string;
  symbolId?: string;
  reason: string;
};

export type CoverageDiagnostics = {
  mayBeIncomplete: boolean;
  authoritativeNegativeResults: boolean;
  gaps: CoverageGap[];
  metrics: CoverageMetric[];
  verificationTargets: VerificationTarget[];
  reasons: string[];
};

export type CoverageDiagnosticsInput = {
  graphState?: CapabilityState;
  resolutionCoverage?: ResolutionCoverage;
  resolutionDiagnostics?: ResolutionDiagnostic[];
  resolverDiagnostics?: ResolverDiagnostic[];
  internalCallResolution?: { resolved: number; total: number };
  change?: {
    files?: ChangedFile[];
    mayBeIncomplete?: boolean;
    reasons?: string[];
    unmappedHunks?: number;
    unmappedFiles?: string[];
    missingBaseline?: number;
  };
  tests?: {
    mayBeIncomplete?: boolean;
    indexUnavailable?: boolean;
    reasons?: string[];
    uncoveredAffectedSymbols?: SymbolReference[];
    uncoveredAffectedFiles?: string[];
  };
  architectureAmbiguities?: number;
  architectureAmbiguityFiles?: string[];
};
