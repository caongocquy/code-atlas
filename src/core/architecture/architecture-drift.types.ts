import type { CoverageDiagnostics } from "../diagnostics/coverage-diagnostics.types.js";
import type { GraphDeltaInput, StructuralEdge, StructuralReference } from "../change/graph-delta.types.js";
import type { InspectChangeSource } from "../change/change.types.js";

export type ArchitectureFindingKind = "forbidden_dependency" | "dependency_cycle" | "unclassified_dependency";
export type DriftStatus = "introduced" | "resolved";
export type ArchitectureConfidence = "high" | "medium" | "low";
export type ArchitectureCause = "code_change" | "policy_change" | "both";

export type ArchitectureEvidence =
  | {
      kind: "graph_delta_edge";
      status: DriftStatus;
      edgeKind: StructuralEdge["kind"];
      from: string;
      to: string;
      source: "transient_source_analysis";
    }
  | {
      kind: "cycle_path";
      path: string[];
      source: "transient_source_analysis";
    };

export type ArchitectureFinding = {
  id: string;
  kind: ArchitectureFindingKind;
  status: DriftStatus;
  cause: ArchitectureCause;
  severity: "low" | "medium" | "high";
  ruleId?: string;
  message: string;
  from?: StructuralReference;
  to?: StructuralReference;
  fromGroup?: string;
  toGroup?: string;
  edgeKind?: StructuralEdge["kind"];
  evidence: ArchitectureEvidence[];
  confidence: ArchitectureConfidence;
};

export type ArchitectureDriftInput = GraphDeltaInput & { configPath?: string };

export type ArchitectureDriftResult = {
  source: InspectChangeSource;
  policy: {
    configured: boolean;
    configPath?: string;
    version?: number;
    cyclesEnabled: boolean;
    baseline: {
      configured: boolean;
      path: string;
      semanticHash?: string;
      sourceKind: "git_revision" | "git_index" | "working_tree" | "absent";
    };
    target: {
      configured: boolean;
      path: string;
      semanticHash?: string;
      sourceKind: "git_revision" | "git_index" | "working_tree" | "absent";
    };
    fileChanged: boolean;
    semanticChanged: boolean;
    changeKind: "unchanged" | "added" | "removed" | "modified";
  };
  summary: {
    introduced: number;
    resolved: number;
    high: number;
    medium: number;
    low: number;
    forbiddenDependencies: number;
    dependencyCycles: number;
  };
  introduced: ArchitectureFinding[];
  resolved: ArchitectureFinding[];
  diagnostics: CoverageDiagnostics;
  mayBeIncomplete: boolean;
  authoritativeNegativeResults: boolean;
  reasons: string[];
};
