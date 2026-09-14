import type { writeFile } from "node:fs/promises";

import type { ContextSubject } from "../../src/core/context/context.types.js";
import type { TaskContextDelivery } from "../../src/core/context/task-context-lifecycle.types.js";
import type { TaskContextLifecycleDeps } from "../../src/core/context/task-context-lifecycle.service.js";
import type { TaskContextAnchor, TaskContextItem, TaskContextReliability } from "../../src/core/context/task-context.types.js";
import type { compileTaskContextForRepository } from "../../src/core/context/task-context-repository-compiler.js";
import type { prepareContextAwareRead } from "../../src/core/context/context-delivery-preparation.js";
import type { startTaskContext, refreshTaskContext, closeTaskContext } from "../../src/core/context/task-context-lifecycle.service.js";
import type { indexRepository } from "../../src/core/indexing/index-pipeline.service.js";
import type { SupportedLanguage } from "../../src/core/graph/parsers/types.js";
import type { ContextStore } from "../../src/storage/context/context.store.js";

export const REPORT_SCHEMA_VERSION = "context-eval-report-v1" as const;
export const CORPUS_VERSION = "context-eval-v1" as const;
export const BASELINE_VERSION = "context-eval-baseline-v1" as const;
export const POLICY_VERSION = "context-eval-policy-v1" as const;

export type CaseKind = "synthetic" | "snapshot";
export type SyntheticClass = "exact-target" | "relationship/change" | "incomplete/ambiguity";
export type DeliveryMode = "full" | "unchanged" | "delta" | "rehydrate" | "error";
export type ScenarioPrimitive =
  | { kind: "start" }
  | { kind: "refresh"; expectedModeSequence?: readonly DeliveryMode[] }
  | { kind: "mutate"; files: Readonly<Record<string, string>> }
  | { kind: "restart" };

export type CorrectnessTruth = {
  requiredSubjects: readonly ContextSubject[];
  supportingSubjects: readonly ContextSubject[];
  forbiddenRequiredSubjects: readonly ContextSubject[];
};

export type QualityPolicy = {
  policyVersion: typeof POLICY_VERSION;
  aggregate: {
    maxEstimatedTokensIncreasePct: number;
    maxReturnedBytesIncreasePct: number;
    maxSelectedItemsIncreasePct: number;
    maxRequiredHitRateDecreasePp: number;
    maxSupportingHitRateDecreasePp: number;
  };
  catastrophic: {
    maxEstimatedTokensMultiplier: number;
    maxReturnedBytesMultiplier: number;
    selectedItemsFormula: string;
    requiredTargetsMayDisappear: boolean;
  };
};

export type ResolvedQualityBudget = {
  aggregate: QualityPolicy["aggregate"];
  catastrophic: {
    maxEstimatedTokens: number;
    maxReturnedBytes: number;
    maxSelectedItems: number;
    requiredTargetsMayDisappear: boolean;
  };
};

export type LifecycleScenario = {
  primitives: readonly ScenarioPrimitive[];
  expectedModes: readonly DeliveryMode[];
};

export type EvalCase = {
  caseId: string;
  kind: CaseKind;
  language: SupportedLanguage;
  syntheticClass?: SyntheticClass;
  workspaceRef: string;
  task: string;
  anchors: readonly TaskContextAnchor[];
  changedPaths: readonly string[];
  lifecycle?: LifecycleScenario;
  truth: CorrectnessTruth;
};

export type SnapshotProvenance = {
  snapshotId: string;
  sourceRepository: string;
  sourceCommitSha: string;
  license: string;
  licenseNoticeRequired: boolean;
  includedPaths: readonly string[];
  language: SupportedLanguage;
  inclusionReason: string;
  licenseNoticePath?: string;
};

export type CorpusManifest = {
  corpusVersion: typeof CORPUS_VERSION;
  cases: readonly EvalCase[];
  snapshots: readonly SnapshotProvenance[];
};

export type BaselineEntry = {
  caseId: string;
  selectedItems: number;
  estimatedTokens: number;
  returnedBytes: number;
  requiredHitRate: number;
  supportingHitRate: number;
  qualityOverrides?: {
    aggregate?: Partial<QualityPolicy["aggregate"]>;
    catastrophic?: Partial<QualityPolicy["catastrophic"]>;
  };
};

export type GoldenBaseline = {
  corpusVersion: typeof CORPUS_VERSION;
  baselineVersion: typeof BASELINE_VERSION;
  policyVersion: typeof POLICY_VERSION;
  entries: readonly BaselineEntry[];
};

export type ObservedMetrics = {
  selectedItems: number;
  estimatedTokens: number;
  returnedBytes: number;
  requiredHitRate: number;
  supportingHitRate: number;
  contextPrecision: number;
  fullItems: number;
  deltaItems: number;
  unchangedItems: number;
  rehydratedItems: number;
  requestedBytes: number;
  savedBytes: number;
  reuseRate: number;
  bodyResendCount: number;
  timingsMs: { indexLoad: number; compile: number; lifecycleStart: number; refresh: number };
};

export type ObservedCase = {
  caseId: string;
  repositoryIdentity: string;
  workspaceIdentity: string;
  taskIdentity: string;
  planIdentity: string;
  selectedItems: readonly TaskContextItem[];
  reliability: TaskContextReliability;
  deliveries: readonly TaskContextDelivery[];
  reconstructedContents: Readonly<Record<string, string>>;
  lifecycleModes: readonly DeliveryMode[];
  metrics: ObservedMetrics;
};

export type NormalizedObserved = Omit<ObservedCase, "metrics"> & { metrics: Omit<ObservedMetrics, "timingsMs"> };

export type GateFailure = {
  gate: string;
  scope: "case" | "corpus" | "integrity";
  caseId?: string;
  observed: string | number | boolean;
  expected: string | number | boolean;
  message: string;
};

export type CaseScore = {
  caseId: string;
  metrics: ObservedMetrics;
  failures: readonly GateFailure[];
  gates: { correctness: boolean; determinism: boolean; reconstruction: boolean; authorityUncertainty: boolean; isolation: boolean; catastrophicQuality: boolean };
};

export type AggregateScore = {
  metrics: ObservedMetrics;
  failures: readonly GateFailure[];
  aggregateQuality: boolean;
};

export type LifecycleObserved = {
  modes: readonly DeliveryMode[];
  fullItems: number;
  deltaItems: number;
  unchangedItems: number;
  rehydratedItems: number;
  requestedBytes: number;
  returnedBytes: number;
  savedBytes: number;
  reuseRate: number;
  bodyResendCount: number;
  sessionIds: readonly string[];
  contextGenerations: readonly string[];
  crossWorkspaceRefused: boolean;
  restartContinuity: boolean;
  casLoserWroteNoStrayState: boolean;
  reconstructedContents: Readonly<Record<string, string>>;
};

export type ReportInput = {
  corpusVersion: typeof CORPUS_VERSION;
  baselineVersion: typeof BASELINE_VERSION;
  baselineSha256: string;
  policyVersion: typeof POLICY_VERSION;
  policySha256: string;
  cases: readonly CaseScore[];
  aggregate: AggregateScore;
};

export type MachineReport = {
  reportSchemaVersion: typeof REPORT_SCHEMA_VERSION;
  corpusVersion: typeof CORPUS_VERSION;
  baselineVersion: typeof BASELINE_VERSION;
  baselineSha256: string;
  policyVersion: typeof POLICY_VERSION;
  policySha256: string;
  cases: readonly { caseId: string; metrics: ObservedMetrics; failures: readonly GateFailure[] }[];
  aggregate: ObservedMetrics;
  gateDecisions: { correctness: boolean; determinism: boolean; reconstruction: boolean; authorityUncertainty: boolean; isolation: boolean; catastrophicQuality: boolean; aggregateQuality: boolean; corpusIntegrity: boolean };
};

export type EvalExecutionDeps = {
  indexRepository?: typeof indexRepository;
  compileTaskContextForRepository?: typeof compileTaskContextForRepository;
  prepareContextAwareRead?: typeof prepareContextAwareRead;
  createContextStore?: (databasePath: string) => ContextStore;
  now?: () => string;
};

export type EvalLifecycleDeps = {
  startTaskContext?: typeof startTaskContext;
  refreshTaskContext?: typeof refreshTaskContext;
  closeTaskContext?: typeof closeTaskContext;
  lifecycleDeps?: TaskContextLifecycleDeps;
  writeFile?: typeof writeFile;
  createContextStore?: (databasePath: string) => ContextStore;
};
