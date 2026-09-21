import type { ArchitectureCause, ArchitectureFindingKind } from "../architecture/architecture-drift.types.js";
import type { ArchitectureSeverity } from "../architecture/architecture-policy.js";
import type { CoverageDiagnostics, CoverageGapKind } from "../diagnostics/coverage-diagnostics.types.js";
import type { InspectChangeInput, InspectChangeSource } from "../change/change.types.js";

export type ChangeGatePolicy = {
  risk?: { maxAllowed?: "low" | "medium" | "high"; allowUnknown?: boolean };
  tests?: { maxUncoveredAffectedSymbols?: number; minStructuralTestEvidenceRatio?: number };
  diagnostics?: { requireAuthoritativeNegativeResults?: boolean; forbidGapKinds?: CoverageGapKind[] };
  architecture?: { failOnSeverityAtLeast?: ArchitectureSeverity; causes?: ArchitectureCause[]; kinds?: ArchitectureFindingKind[] };
};

export type GateSourceKind = "git_revision" | "git_index" | "working_tree" | "absent";
export type ChangeGatePolicySnapshot = {
  configured: boolean;
  source: { path: string; kind: GateSourceKind; revision?: string };
  policy?: ChangeGatePolicy;
  semanticHash?: string;
};

export type ChangeGatePolicyPair = {
  path: string;
  baseline: ChangeGatePolicySnapshot;
  target: ChangeGatePolicySnapshot;
  fileChanged: boolean;
  semanticChanged: boolean;
  changeKind: "unchanged" | "added" | "removed" | "modified";
};

export type GateStatus = "pass" | "fail" | "not_configured";
export type GateCheckStatus = "pass" | "fail" | "warn" | "skipped";
export type GateCategory = "risk" | "tests" | "diagnostics" | "architecture";
export type GateEvidence = {
  kind: "architecture_finding" | "diagnostic_gap" | "test_gap";
  id?: string;
  detail: string;
  file?: string;
};
export type GateCheck = {
  id: string;
  category: GateCategory;
  status: GateCheckStatus;
  message: string;
  actual?: string | number | boolean;
  expected?: string | number | boolean | { max?: string | number; min?: string | number; atLeast?: string };
  evidence?: GateEvidence[];
};
export type GateSummary = { passed: number; failed: number; warnings: number; skipped: number };
export type ChangeGateInput = InspectChangeInput & {
  maxTests?: number;
  maxEdges?: number;
};
export type ChangeGateResult = {
  source: InspectChangeSource;
  status: GateStatus;
  policy: {
    configured: boolean;
    enforcementSource: "baseline" | "target_bootstrap" | "none";
    baseline: { configured: boolean; path: string; semanticHash?: string; sourceKind: GateSourceKind };
    target: { configured: boolean; path: string; semanticHash?: string; sourceKind: GateSourceKind };
    semanticChanged: boolean;
  };
  summary: GateSummary;
  checks: GateCheck[];
  diagnostics: CoverageDiagnostics;
  preview?: { policy: "target"; status: GateStatus; checks: GateCheck[]; summary: GateSummary } | { policy: "target"; status: "not_configured"; checks: []; summary: GateSummary };
};
