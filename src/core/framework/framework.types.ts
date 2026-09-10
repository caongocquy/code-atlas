import type {
  MaterializedFileFacts,
  SourceRangeFact,
} from "../facts/facts.types.js";
import type { CodeGraph } from "../graph/types.js";

export type FrameworkId = "react" | "next" | "nestjs" | "spring" | "flutter";

export type FrameworkEntityKind = "route" | "layout";

export interface FrameworkEntityRef {
  framework: FrameworkId;
  kind: FrameworkEntityKind;
  logicalKey: string;
}

export type FrameworkSubjectRef =
  | { kind: "language"; nodeId: string }
  | { kind: "framework"; entity: FrameworkEntityRef };

export type FrameworkRelationKind =
  | "component_usage"
  | "route_binding"
  | "layout_binding"
  | "controller_route"
  | "module_provider"
  | "dependency_injection"
  | "bean_relationship"
  | "widget_composition"
  | "navigation_binding";

export type FrameworkClassificationKind = "execution_boundary";

export type FrameworkDiagnosticCode =
  | "framework_construct_unsupported"
  | "framework_target_ambiguous"
  | "framework_target_unknown"
  | "framework_budget_exhausted"
  | "framework_config_incomplete"
  | "framework_adapter_failed"
  | "framework_entity_identity_collision"
  | "framework_subject_ambiguous"
  | "framework_subject_unknown"
  | "framework_classification_conflict";

export type FrameworkOutcome =
  | "resolved"
  | "ambiguous"
  | "unknown"
  | "unsupported"
  | "budget_exhausted";

export interface FrameworkEvidenceRef {
  relativePath: string;
  inputKey: string;
  localId?: string;
  range?: SourceRangeFact;
}

export interface FrameworkProvenance {
  origin: "framework_inferred";
  framework: FrameworkId;
  adapterId: string;
  adapterVersion: string;
  strategy: string;
  confidence: "exact" | "strong";
  evidenceIds: readonly string[];
  refs: readonly FrameworkEvidenceRef[];
}

export interface FrameworkEntity {
  ref: FrameworkEntityRef;
  displayName: string;
  provenance: FrameworkProvenance;
}

export interface FrameworkRelationship {
  outputKind: "relationship";
  source: FrameworkSubjectRef;
  target: FrameworkSubjectRef;
  relationKind: FrameworkRelationKind;
  provenance: FrameworkProvenance;
}

export interface FrameworkClassification {
  outputKind: "classification";
  subject: FrameworkSubjectRef;
  classificationKind: FrameworkClassificationKind;
  classificationValue: "client" | "server";
  provenance: FrameworkProvenance;
}

export type FrameworkAcceptedOutput = FrameworkRelationship | FrameworkClassification;

export interface FrameworkEntityObservation {
  ref: FrameworkEntityRef;
  displayName: string;
  declarationKey: string;
  confidence: "exact" | "strong" | "weak";
  refs: readonly FrameworkEvidenceRef[];
}

export interface FrameworkEvidenceBase {
  evidenceId: string;
  framework: FrameworkId;
  adapterId: string;
  adapterVersion: string;
  strategy: string;
  capability: string;
  relativePath: string;
  origin: "framework_inferred";
  confidence: "exact" | "strong" | "weak";
  refs: readonly FrameworkEvidenceRef[];
  entities: readonly FrameworkEntityObservation[];
  applicable: boolean;
  supported: boolean;
  attempted: boolean;
  state: "candidate" | "unknown" | "unsupported" | "budget_exhausted";
}

export type FrameworkEvidence = FrameworkEvidenceBase & (
  | {
      outputKind: "relationship";
      relationKind: FrameworkRelationKind;
      sourceCandidates: readonly FrameworkSubjectRef[];
      targetCandidates: readonly FrameworkSubjectRef[];
    }
  | {
      outputKind: "classification";
      classificationKind: FrameworkClassificationKind;
      subjectCandidates: readonly FrameworkSubjectRef[];
      values: readonly ("client" | "server")[];
    }
);

export interface FrameworkCoverage {
  framework: FrameworkId;
  capability: string;
  relativePath: string;
  strategy: string;
  outputKind: "relationship" | "classification";
  kind: FrameworkRelationKind | FrameworkClassificationKind;
  applicable: number;
  supported: number;
  attempted: number;
  resolved: number;
  ambiguous: number;
  unknown: number;
  unsupported: number;
  budgetExhausted: number;
  weakDropped: number;
}

export interface FrameworkDiagnostic {
  code: FrameworkDiagnosticCode;
  outcome: Exclude<FrameworkOutcome, "resolved">;
  framework: FrameworkId;
  capability: string;
  relativePath: string;
  strategy: string;
  evidenceIds: readonly string[];
  refs: readonly FrameworkEvidenceRef[];
  reason: string;
}

export type FrameworkConfigValue =
  | null
  | boolean
  | number
  | string
  | readonly FrameworkConfigValue[]
  | { readonly [key: string]: FrameworkConfigValue };

export interface FrameworkConfigFact {
  relativePath: string;
  scope: string;
  inputKey: string;
  kind: "package" | "next" | "maven" | "gradle" | "pubspec";
  values: Readonly<Record<string, FrameworkConfigValue>>;
  complete: boolean;
}

export interface FrameworkDependency {
  framework: FrameworkId;
  scope: string;
  ownerPath: string;
  inputKeys: readonly string[];
  lookupKeys: readonly string[];
  complete: boolean;
}

export interface FrameworkMaterialization {
  frameworkResolutionVersion: string;
  entities: readonly FrameworkEntity[];
  relationships: readonly FrameworkRelationship[];
  classifications: readonly FrameworkClassification[];
  diagnostics: readonly FrameworkDiagnostic[];
  coverage: readonly FrameworkCoverage[];
  config: readonly FrameworkConfigFact[];
  detections: readonly DetectionResult[];
  dependencies: readonly FrameworkDependency[];
  complete: boolean;
}

export interface FrameworkSnapshot extends FrameworkMaterialization {
  repositoryId: string;
  generationId: string;
}

export interface DetectionResult {
  framework: FrameworkId;
  scope: string;
  configured: boolean;
  observed: boolean;
  capabilities: readonly string[];
  refs: readonly FrameworkEvidenceRef[];
  complete: boolean;
}

export interface FrameworkDetectionContext {
  repositoryId: string;
  facts: readonly MaterializedFileFacts[];
  graph: Readonly<CodeGraph>;
  config: readonly FrameworkConfigFact[];
}

export interface FrameworkAnalysisContext extends FrameworkDetectionContext {
  generationId: string;
  frameworkResolutionVersion: string;
  detections: readonly DetectionResult[];
  analyzePaths: ReadonlySet<string>;
  maxObservations: number;
}

export interface FrameworkAdapterResult {
  evidence: readonly FrameworkEvidence[];
  dependencies: readonly FrameworkDependency[];
}

export interface FrameworkSemanticAdapter {
  id: string;
  version: string;
  frameworks: readonly FrameworkId[];
  detect(ctx: FrameworkDetectionContext): readonly DetectionResult[];
  analyze(ctx: FrameworkAnalysisContext): FrameworkAdapterResult;
}

export interface FrameworkCanonicalRoute {
  framework: FrameworkId;
  scope: string;
  router: string;
  kind: FrameworkEntityKind;
  path: string;
  method: string | null;
  conditions: readonly string[];
  owner: string | null;
}

export type FrameworkCanonicalization =
  | { kind: "canonical"; ref: FrameworkEntityRef }
  | { kind: "unresolved"; code: FrameworkDiagnosticCode; reason: string };
