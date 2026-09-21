import type { SourceRangeFact } from "../facts/facts.types.js";

export type EvidenceOrigin = "extracted" | "language_inferred" | "framework_inferred" | "derived";

export type ReliabilityOutcome =
  | "accepted"
  | "ambiguous"
  | "unknown"
  | "unsupported"
  | "budget_exhausted";

export interface EvidenceRef {
  origin: EvidenceOrigin;
  sourcePath?: string;
  inputKey: string;
  localId?: string;
  range?: SourceRangeFact;
  ownerKey: string;
}

export interface ReliabilityScope {
  scopeKey: string;
  capability: string;
  outputKind?: string;
  framework?: string;
  language?: string;
  selectorKey?: string;
}

export interface ReliabilityScopeInput {
  capability: string;
  outputKind?: string;
  framework?: string;
  language?: string;
  selectorKey?: string;
}

export interface DiagnosticRef {
  code: string;
  outcome: ReliabilityOutcome | "adapter_failed";
  ownerKey: string;
  evidenceIds: readonly string[];
}

export interface CoverageContribution {
  applicable: boolean;
  supported: boolean;
  attempted: boolean;
  resolved: boolean;
  ambiguous: boolean;
  unknown: boolean;
  unsupported: boolean;
  budgetExhausted: boolean;
}

export interface CoverageSummary {
  applicable: number;
  supported: number;
  attempted: number;
  resolved: number;
  ambiguous: number;
  unknown: number;
  unsupported: number;
  budgetExhausted: number;
}

export interface ReliabilityContribution {
  ownerKey: string;
  scope: ReliabilityScope;
  outputKey: string;
  outcome: ReliabilityOutcome;
  complete: boolean;
  stale: boolean;
  origin: EvidenceOrigin;
  evidence: readonly EvidenceRef[];
  diagnostics: readonly DiagnosticRef[];
  coverage: CoverageContribution;
}

export interface EvidenceSummary {
  total: number;
  origins: readonly EvidenceOrigin[];
}

export interface ReliabilityDetail {
  evidence?: readonly EvidenceRef[];
  diagnostics?: readonly DiagnosticRef[];
  detailTruncated: boolean;
  evidenceReturned?: number;
  evidenceTotal?: number;
  diagnosticsReturned?: number;
  diagnosticsTotal?: number;
}

export interface ReliabilityProjection {
  scope: ReliabilityScope;
  outcome: ReliabilityOutcome;
  complete: boolean;
  stale: boolean;
  authoritative: boolean;
  authoritativeNegative: boolean;
  coverage: CoverageSummary;
  diagnosticCodes: readonly string[];
  evidenceSummary: EvidenceSummary;
  detail?: ReliabilityDetail;
}

export type ReliabilityOutputDescriptor =
  | { kind: "entity"; entityKey: string }
  | { kind: "relationship"; sourceKey: string; targetKey: string; relationKind: string }
  | { kind: "classification"; subject: { kind: "language" | "framework"; nodeId?: string; entityKey?: string }; classificationKind: string }
  | { kind: "diagnostic"; code: string; evidenceKey: string };

export interface ReliabilityOwnerInput {
  sourcePath?: string;
  inputKey: string;
  capability?: string;
  adapterId?: string;
}
