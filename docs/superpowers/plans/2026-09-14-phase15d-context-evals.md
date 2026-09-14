# Phase15D Context Evaluation & Regression Gates Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an internal, deterministic, offline Phase15D evaluator that
exercises the production Phase15A/B/C APIs and blocks correctness or quality
regressions with reviewable corpus, baseline, and machine-report evidence.

**Architecture:** A context-specific runner loads versioned declarative cases,
validates corpus and baseline integrity, materializes an isolated workspace,
indexes it through `indexRepository`, executes Phase15B selection and the
Phase15A/15C delivery APIs, then normalizes, scores, aggregates, reports, and
returns a deterministic gate exit code. Baseline update is a separate
explicitly opted-in command; no production API receives an eval-only branch.

**Tech Stack:** Node.js 22+, TypeScript/ESM, Node built-ins (`node:test`,
`node:fs/promises`, `node:crypto`, `node:child_process`), existing `zod`,
existing Phase15A/B/C services, existing Tree-sitter language registry, and
the repository's current `npm run test`, `npm run build`, and `npm run lint`
tooling.

**Spec:** docs/superpowers/specs/2026-09-14-phase15d-context-evals-design.md

## Global Constraints

- Phase15D is an internal release gate only.
- No public `code-atlas eval` command.
- No MCP evaluation tools.
- No LLM judge.
- No API, network, cloud, Docker, GPU, or runtime corpus download dependency.
- No runtime GitHub cloning or upstream repository fetching.
- No generic graph/search/impact evaluation framework.
- No eval-only production execution path.
- Production Phase15A/B/C behavior must not be weakened or special-cased.
- `npm run eval:context` is read-only with respect to correctness truth and the golden baseline.
- `npm run eval:context:update-baseline` writes only after explicit `--write` and never changes correctness truth.
- Every case has a fresh isolated workspace and independent `.codeatlas` state; lifecycle state may persist only inside its own scenario.
- Synthetic language coverage is derived from `LANGUAGE_CONFIGS` in `src/core/graph/parsers/languages.ts`, never from a duplicate language list.
- Exact `planIdentity` equality is asserted only when every participating repository/workspace identity input is identical; otherwise compare semantic plan behavior without rewriting hashes.
- Timing and performance observations never participate in semantic equality or PASS/FAIL gates.
- Baseline and policy identity use SHA-256 of raw UTF-8 file bytes exactly as read from disk.
- The evaluator must preserve exact reconstruction, authority/uncertainty, lifecycle, workspace, and Phase15A/B/C race invariants from the spec.

## Current repository seams

The implementation must reuse these existing contracts:

- `LANGUAGE_CONFIGS: readonly LanguageConfig[]` and `SupportedLanguage` from `src/core/graph/parsers/languages.ts` and `src/core/graph/parsers/types.ts`.
- `indexRepository(repoPath: string, options?: IndexPipelineOptions): Promise<IndexRunOutcome>` from `src/core/indexing/index-pipeline.service.ts`; use `skipGit: true` for non-Git synthetic workspaces and normal Git initialization where a case requires Git identity or worktree behavior.
- `compileTaskContextForRepository(repoPath: string, input: CompileTaskContextInput, deps?: RepositoryCompilerDeps): Promise<TaskContextPlanDetail>` from `src/core/context/task-context-repository-compiler.ts`.
- `TaskContextPlanDetail`, `TaskContextItem`, `TaskContextReliability`, `ContextSubject`, and `CompileTaskContextInput` from `src/core/context/task-context.types.ts`.
- `prepareContextAwareRead(repoPath, request, store)` and `PreparedContextAwareRead` from `src/core/context/context-delivery-preparation.ts` for controlled delivery observations.
- `startTaskContext`, `refreshTaskContext`, and `closeTaskContext` from `src/core/context/task-context-lifecycle.service.ts`, with `TaskContextLifecycleResult` and `TaskContextLifecycleMetrics` from `src/core/context/task-context-lifecycle.types.ts`.
- `ContextStore` and `.codeatlas/context.db` from `src/storage/context/context.store.ts`.
- Existing `mkdtemp`, `writeFile`, `rm`, `execFile`, Git initialization, and cleanup patterns in `test/phase15c-smoke.test.ts`, `test/phase15c-lifecycle-service.test.ts`, and `test/phase13-remediation.test.ts`.
- Existing `test/helpers/phase14b-language-fixtures.ts` for parser fixture style only; do not copy its `targetLanguages` list into evaluator production code.

## File responsibility map

Create these implementation files unless a task's tests prove two adjacent
responsibilities can remain in one file without blurring their interfaces:

- `eval/context/types.ts` — all public evaluator domain types, version literals, gate result types, and exact scenario/result contracts.
- `eval/context/schemas.ts` — Zod runtime schemas for every JSON boundary and typed parsing helpers.
- `eval/context/corpus/load-corpus.ts` — raw file loading, SHA-256 file digesting, schema parsing, and corpus/baseline/policy integrity validation.
- `eval/context/corpus/materialize-workspace.ts` — clean temporary workspace creation, fixture copy, optional Git setup, `.codeatlas` isolation, and `finally` cleanup.
- `eval/context/runner/execute-case.ts` — index, compile, delivery, and bounded lifecycle scenario execution through production APIs.
- `eval/context/runner/normalize-result.ts` — host-noise removal and semantic comparison; performance fields are excluded.
- `eval/context/runner/score-case.ts` — per-case truth, reconstruction, authority, uncertainty, isolation, determinism, and catastrophic quality scoring.
- `eval/context/runner/aggregate.ts` — corpus aggregate metrics and aggregate quality gates.
- `eval/context/runner/report.ts` — stable human report and `context-eval-report-v1` machine report.
- `eval/context/runner/update-baseline.ts` — candidate baseline generation, old-to-new diff, and `--write` guard.
- `eval/context/run.ts` — normal evaluator entrypoint, exit-code mapping, and report artifact orchestration.
- `eval/context/update-baseline.ts` — developer-only baseline command entrypoint.
- `eval/context/corpus/manifest.json` — `context-eval-v1` manifest.
- `eval/context/corpus/synthetic/` — reviewed synthetic fixtures and JSON cases for every production language/class combination.
- `eval/context/corpus/snapshots/` — reviewed frozen source snapshots and provenance/license notices; no runtime download logic.
- `eval/context/baselines/context-eval-v1.json` — reviewed baseline, `baselineVersion`, `policyVersion`, and quality policy data.
- `eval/context/baselines/context-eval-policy-v1.json` — separately versioned quality policy whose raw bytes receive the machine-report policy digest.
- `test/phase15d-contracts.test.ts` through `test/phase15d-acceptance.test.ts` — focused Node test files named by task below.
- `package.json` — only the two internal scripts; preserve existing scripts and dependencies.
- `.gitignore` — ignore only transient `artifacts/context-eval-report.json` (or its containing artifact directory) according to the existing generated-artifact convention.
- `.github/workflows/context-eval.yml` — CI release-gate job that runs the internal evaluator offline and uploads reports.

Do not create a public CLI command, MCP registration, generic benchmark
package, network client, or production-service eval mode.

## Shared interfaces and exact contracts

Task 1 owns these types. Later tasks must import them rather than redefine
parallel shapes:

```ts
export const REPORT_SCHEMA_VERSION = "context-eval-report-v1" as const;
export const CORPUS_VERSION = "context-eval-v1" as const;
export const BASELINE_VERSION = "context-eval-baseline-v1" as const;
export const POLICY_VERSION = "context-eval-policy-v1" as const;

export type CaseKind = "synthetic" | "snapshot";
export type SyntheticClass = "exact-target" | "relationship/change" | "incomplete/ambiguity";
export type ScenarioPrimitive =
  | { kind: "start" }
  | { kind: "refresh"; expectedModeSequence?: readonly DeliveryMode[] }
  | { kind: "mutate"; files: Readonly<Record<string, string>> }
  | { kind: "restart" };
export type DeliveryMode = "full" | "unchanged" | "delta" | "rehydrate" | "error";

export type CorrectnessTruth = {
  requiredSubjects: readonly ContextSubject[];
  supportingSubjects: readonly ContextSubject[];
  forbiddenRequiredSubjects: readonly ContextSubject[];
};

export type QualityBudget = {
  maxTokenIncreasePct: number;
  maxReturnedBytesIncreasePct: number;
  maxSelectedItemsIncreasePct: number;
  maxSupportingHitRateDecreasePp: number;
  catastrophicMaxEstimatedTokens: number;
  catastrophicMaxReturnedBytes: number;
  catastrophicMaxSelectedItems: number;
};

export type QualityPolicy = {
  policyVersion: typeof POLICY_VERSION;
  aggregate: {
    maxEstimatedTokensIncreasePct: 10;
    maxReturnedBytesIncreasePct: 10;
    maxSelectedItemsIncreasePct: 10;
    maxRequiredHitRateDecreasePp: 0;
    maxSupportingHitRateDecreasePp: 5;
  };
  catastrophic: {
    maxEstimatedTokensMultiplier: 2;
    maxReturnedBytesMultiplier: 2;
    selectedItemsFormula: "baselineSelectedItems + max(3, baselineSelectedItems)";
    requiredTargetsMayDisappear: false;
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
  qualityBudget?: Partial<QualityBudget>;
};

export type SnapshotProvenance = {
  snapshotId: string;
  sourceRepository: string;
  sourceCommitSha: string;
  license: string;
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
  regressionBudget: QualityBudget;
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

export type NormalizedObserved = Omit<ObservedCase, "metrics"> & {
  metrics: Omit<ObservedMetrics, "timingsMs">;
};

export type GateFailure = {
  gate: string;
  scope: "case" | "corpus" | "integrity";
  caseId?: string;
  observed: string | number | boolean;
  expected: string | number | boolean;
  message: string;
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
```

`ContextSubject`, `TaskContextAnchor`, and `SupportedLanguage` are imported
from production modules. Zod schemas must reject extra version combinations,
invalid subject paths, malformed IDs, duplicate IDs, negative metrics, and
unknown scenario primitives before case execution.

## Implementation tasks

### Task 1: Evaluator contracts, schemas, and corpus integrity

**Files:**
- Create: `eval/context/types.ts`
- Create: `eval/context/schemas.ts`
- Create: `eval/context/corpus/load-corpus.ts`
- Create: `test/phase15d-contracts.test.ts`
- Create: `test/phase15d-corpus-integrity.test.ts`

**Interfaces:**
- Consumes: production `ContextSubject`, `TaskContextAnchor`, `SupportedLanguage`, and raw JSON files.
- Produces: `parseCorpusManifest(raw: unknown): CorpusManifest`, `parseGoldenBaseline(raw: unknown): GoldenBaseline`, `parseQualityPolicy(raw: unknown): QualityPolicy`, `sha256File(path: string): Promise<string>`, and `validateCorpusIntegrity(input: { manifest: CorpusManifest; baseline: GoldenBaseline; policy: QualityPolicy; manifestPath: string; baselinePath: string; policyPath: string }): void`.

- [ ] **Step 1: Write failing contract tests.** Assert all version literals, exact required fields, scenario discriminants, raw-byte SHA-256, and rejection of unknown versions, malformed metrics, invalid subjects, and duplicate IDs.
- [ ] **Step 2: Run RED.** `node --import tsx/esm --test test/phase15d-contracts.test.ts test/phase15d-corpus-integrity.test.ts`; expect module-not-found failures for the new evaluator modules.
- [ ] **Step 3: Implement schemas and loaders.** Use Zod schemas with literal versions; derive supported language IDs at validation time from `LANGUAGE_CONFIGS.map(({ language }) => language)`; hash bytes from `readFile(path)` before JSON parsing; require exact `context-eval-v1`, `context-eval-baseline-v1`, and `context-eval-policy-v1` relationships.
- [ ] **Step 4: Run GREEN.** Repeat the same command; expect all contract and integrity tests to pass, including missing/orphan/duplicate/incompatible data failures.
- [ ] **Step 5: Commit implementation.** `git add eval/context/types.ts eval/context/schemas.ts eval/context/corpus/load-corpus.ts test/phase15d-contracts.test.ts test/phase15d-corpus-integrity.test.ts && git commit -m "test(eval): define Phase15D corpus contracts"`.

### Task 2: Isolated workspace materialization and offline boundary

**Files:**
- Create: `eval/context/corpus/materialize-workspace.ts`
- Create: `test/phase15d-workspace.test.ts`

**Interfaces:**
- Consumes: `EvalCase`, corpus fixture paths, Node filesystem and child-process APIs.
- Produces: `materializeWorkspace(input: { case: EvalCase; fixtureRoot: string }): Promise<{ root: string; cleanup: () => Promise<void>; git: boolean }>`.

- [ ] **Step 1: Write failing tests.** Verify independent roots, copied source, no inherited `.codeatlas`, optional Git repository setup with deterministic local identity, cleanup after success/failure, and no writes under `process.cwd()`.
- [ ] **Step 2: Run RED.** `node --import tsx/esm --test test/phase15d-workspace.test.ts`; expect the materializer import to fail.
- [ ] **Step 3: Implement.** Use `mkdtemp` under the OS temp directory, copy only declared fixture files, create `.codeatlas` only when production indexing needs it, initialize Git using `execFile`, and return an idempotent cleanup function that removes only the generated root.
- [ ] **Step 4: Run GREEN.** Repeat the test command; expect isolation and cleanup assertions to pass.
- [ ] **Step 5: Commit.** `git add eval/context/corpus/materialize-workspace.ts test/phase15d-workspace.test.ts && git commit -m "feat(eval): isolate Phase15D workspaces"`.

### Task 3: Production case execution and semantic normalization

**Files:**
- Create: `eval/context/runner/execute-case.ts`
- Create: `eval/context/runner/normalize-result.ts`
- Create: `test/phase15d-execution.test.ts`
- Create: `test/phase15d-determinism.test.ts`

**Interfaces:**
- Consumes: `materializeWorkspace`, `indexRepository`, `compileTaskContextForRepository`, `prepareContextAwareRead`, and Task Context production types.
- Produces: `executeCase(input: { evalCase: EvalCase; fixtureRoot: string }): Promise<ObservedCase>`, `normalizeObserved(value: ObservedCase): NormalizedObserved`, and `compareSemanticObserved(left: NormalizedObserved, right: NormalizedObserved, identityInputsEqual: boolean): readonly GateFailure[]`.

`ObservedCase` and `NormalizedObserved` are the exact types defined in the
shared contract block. `normalizeObserved` removes only temporary absolute
workspace roots from identity-bearing paths and removes `timingsMs` from the
comparison value; it retains both raw repository/workspace identities and
`planIdentity` for the conditional comparison rule.

- [ ] **Step 1: Write failing tests.** Stub production dependencies through explicit dependency parameters and assert indexing, compile input, selected item order, delivery observation, and semantic comparison. Include one pair with differing repository/workspace identity inputs and one pair with identical inputs.
- [ ] **Step 2: Run RED.** `node --import tsx/esm --test test/phase15d-execution.test.ts test/phase15d-determinism.test.ts`; expect missing executor/normalizer exports.
- [ ] **Step 3: Implement.** Index each materialized repository, compile with `task`, `anchors`, `changedPaths`, `detail: "full"`, execute selected subjects through `prepareContextAwareRead`, and capture raw identity fields. Compare normalized selected sequence, rank/order, classifications, reliability/completeness, task identity semantics, delivery modes/items, and reconstruction. Require exact `planIdentity` only when all inputs participating in it are equal; never rewrite hashes.
- [ ] **Step 4: Run GREEN.** Repeat the command; expect identity-conditional determinism tests to pass and timing-only differences to be ignored.
- [ ] **Step 5: Commit.** `git add eval/context/runner/execute-case.ts eval/context/runner/normalize-result.ts test/phase15d-execution.test.ts test/phase15d-determinism.test.ts && git commit -m "feat(eval): execute and normalize context cases"`.

### Task 4: Deterministic correctness and authority scorer

**Files:**
- Create: `eval/context/runner/score-case.ts`
- Create: `test/phase15d-correctness.test.ts`

**Interfaces:**
- Consumes: `EvalCase`, `ObservedCase`, `NormalizedObserved`, `BaselineEntry` only for metrics, and `compareSemanticObserved`.
- Produces: `scoreCase(input: { evalCase: EvalCase; first: ObservedCase; repeat: ObservedCase; baseline?: BaselineEntry }): CaseScore` where `CaseScore` contains `metrics`, `failures`, and every boolean gate decision.

- [ ] **Step 1: Write failing tests.** Cover 100% required hits, zero false required, forbidden required subjects, exact source reconstruction from full/delta/rehydrate outputs, stale/incomplete uncertainty, stable task intent, cross-workspace refusal, CAS-no-stray-publication evidence, and deterministic plan/selection behavior.
- [ ] **Step 2: Run RED.** `node --import tsx/esm --test test/phase15d-correctness.test.ts`; expect missing scorer exports.
- [ ] **Step 3: Implement.** Match subjects by validated canonical subject identity, calculate required/supporting hit rates, reject any forbidden promotion, verify reconstructed content hashes and authoritative text, preserve reliability diagnostics, and convert every failed invariant into a typed `GateFailure`.
- [ ] **Step 4: Run GREEN.** Repeat the command; expect every correctness failure to be non-zero-ready and every valid case to score zero failures.
- [ ] **Step 5: Commit.** `git add eval/context/runner/score-case.ts test/phase15d-correctness.test.ts && git commit -m "feat(eval): score Phase15D correctness gates"`.

### Task 5: Quality metrics, catastrophic ceilings, and aggregate policy

**Files:**
- Create: `eval/context/runner/aggregate.ts`
- Modify: `eval/context/runner/score-case.ts`
- Create: `test/phase15d-quality.test.ts`

**Interfaces:**
- Consumes: `CaseScore`, `BaselineEntry`, `QualityBudget`, and the exact policy data loaded by Task 1.
- Produces: `scoreQuality(input: { metrics: ObservedMetrics; baseline: BaselineEntry }): readonly GateFailure[]` and `aggregateScores(scores: readonly CaseScore[], baselines: ReadonlyMap<string, BaselineEntry>): AggregateScore`.

- [ ] **Step 1: Write failing tests.** Assert aggregate +10% limits, required-hit monotonicity, supporting-hit-rate five-point budget, exact catastrophic formula `baselineSelectedItems + max(3, baselineSelectedItems)`, 2× token/byte ceilings, and missing baseline rejection.
- [ ] **Step 2: Run RED.** `node --import tsx/esm --test test/phase15d-quality.test.ts`; expect missing quality exports.
- [ ] **Step 3: Implement.** Keep thresholds in parsed baseline/policy data; calculate deterministic aggregate sums/rates; apply per-case catastrophic ceilings before aggregate budgets; never let a baseline update suppress a correctness failure.
- [ ] **Step 4: Run GREEN.** Repeat the test command; expect all boundary and rounding tests to pass.
- [ ] **Step 5: Commit.** `git add eval/context/runner/aggregate.ts eval/context/runner/score-case.ts test/phase15d-quality.test.ts && git commit -m "feat(eval): add Phase15D quality gates"`.

### Task 6: Lifecycle scenario execution and metrics

**Files:**
- Modify: `eval/context/runner/execute-case.ts`
- Modify: `eval/context/runner/score-case.ts`
- Create: `test/phase15d-lifecycle.test.ts`

**Interfaces:**
- Consumes: `LifecycleScenario`, `ScenarioPrimitive`, `startTaskContext`, `refreshTaskContext`, `ContextStore`, and `TaskContextLifecycleMetrics`.
- Produces: `executeLifecycleScenario(input: { evalCase: EvalCase; root: string }): Promise<LifecycleObserved>` and `scoreLifecycle(value: LifecycleObserved, expected: LifecycleScenario): readonly GateFailure[]`.

Define `LifecycleObserved` with `modes`, `fullItems`, `deltaItems`, `unchangedItems`, `rehydratedItems`, `requestedBytes`, `returnedBytes`, `savedBytes`, `reuseRate`, `bodyResendCount`, restart continuity identities, and reconstruction results.

- [ ] **Step 1: Write failing tests.** Execute `start -> unchanged refresh -> mutate -> refresh -> restart -> refresh`; assert mode sequence, no body resend for unchanged, exact changed reconstruction, stable session/generation, and isolation from another workspace.
- [ ] **Step 2: Run RED.** `node --import tsx/esm --test test/phase15d-lifecycle.test.ts`; expect missing lifecycle executor/scorer exports.
- [ ] **Step 3: Implement.** Interpret only the four declared primitives, preserve the same materialized root and `.codeatlas/context.db` within one scenario, reopen the store/service boundary for restart, and aggregate production lifecycle metrics without changing lifecycle code.
- [ ] **Step 4: Run GREEN.** Repeat the command; expect restart, reuse, delta/rehydrate, and isolation assertions to pass.
- [ ] **Step 5: Commit.** `git add eval/context/runner/execute-case.ts eval/context/runner/score-case.ts test/phase15d-lifecycle.test.ts && git commit -m "feat(eval): exercise lifecycle delivery scenarios"`.

### Task 7: Stable reports and deterministic failure semantics

**Files:**
- Create: `eval/context/runner/report.ts`
- Create: `test/phase15d-report.test.ts`

**Interfaces:**
- Consumes: `AggregateScore`, `CaseScore`, raw baseline/policy bytes, version literals, and `GateFailure`.
- Produces: `buildMachineReport(input: ReportInput): MachineReport`, `renderHumanReport(report: MachineReport): string`, and `writeReport(path: string, report: MachineReport): Promise<void>`.

- [ ] **Step 1: Write failing tests.** Assert exact report versions, raw baseline/policy SHA-256, stable key/array ordering, omission of timing fields from semantic comparisons only, readable failure details, and all required gate decisions.
- [ ] **Step 2: Run RED.** `node --import tsx/esm --test test/phase15d-report.test.ts`; expect missing report exports.
- [ ] **Step 3: Implement.** Serialize machine JSON with stable ordering, retain timings only as observations, render PASS/FAIL and corpus/quality/lifecycle summaries, and write only to the transient `artifacts/context-eval-report.json` path.
- [ ] **Step 4: Run GREEN.** Repeat the command; expect byte-stable reports for equal semantic inputs and explicit version/digest identity.
- [ ] **Step 5: Commit.** `git add eval/context/runner/report.ts test/phase15d-report.test.ts && git commit -m "feat(eval): emit deterministic evaluation reports"`.

### Task 8: Normal evaluator entrypoint and baseline update workflow

**Files:**
- Create: `eval/context/run.ts`
- Create: `eval/context/runner/update-baseline.ts`
- Create: `eval/context/update-baseline.ts`
- Create: `test/phase15d-runner.test.ts`
- Create: `test/phase15d-baseline-update.test.ts`

**Interfaces:**
- Consumes: corpus loader, materializer, executor, normalizer, scorers, aggregator, and reporter.
- Produces: `runContextEval(args: { cwd: string; reportPath: string }): Promise<{ report: MachineReport; exitCode: 0 | 1 }>` and `updateContextBaseline(args: { cwd: string; write: boolean }): Promise<{ candidate: GoldenBaseline; diff: string; wrote: boolean }>`.

- [ ] **Step 1: Write failing tests.** Assert normal eval runs every case, repeats required cases, writes no corpus/baseline bytes, produces non-zero for every listed hard/integrity/quality failure, and baseline update shows old-to-new metrics but refuses correctness failures and writes only with `write: true`.
- [ ] **Step 2: Run RED.** `node --import tsx/esm --test test/phase15d-runner.test.ts test/phase15d-baseline-update.test.ts`; expect missing entrypoint exports.
- [ ] **Step 3: Implement.** Load and validate all inputs before execution, run all context-selection correctness cases twice from independent clean roots, repeat lifecycle scenarios from equivalent clean/persisted state, map any correctness/determinism/reconstruction/authority/uncertainty/isolation/catastrophic/aggregate/integrity failure to exit 1, and keep performance non-blocking. Baseline update uses raw bytes for old identity, emits a diff, and writes only when `--write` is present and all correctness gates pass.
- [ ] **Step 4: Run GREEN.** Repeat the command; expect read-only and explicit-write tests to pass.
- [ ] **Step 5: Commit.** `git add eval/context/run.ts eval/context/runner/update-baseline.ts eval/context/update-baseline.ts test/phase15d-runner.test.ts test/phase15d-baseline-update.test.ts && git commit -m "feat(eval): add context eval and baseline workflows"`.

### Task 9: Corpus manifest, synthetic matrix, and frozen snapshots

**Files:**
- Create: `eval/context/corpus/manifest.json`
- Create: `eval/context/corpus/synthetic/` fixture files and case files for each registry language/class
- Create: `eval/context/corpus/snapshots/` reviewed source files, provenance, and required notices
- Create: `eval/context/baselines/context-eval-v1.json`
- Create: `eval/context/baselines/context-eval-policy-v1.json`
- Create: `test/phase15d-corpus-content.test.ts`

**Interfaces:**
- Consumes: production `LANGUAGE_CONFIGS`, Task 1 schemas, and repository-reviewed source snapshot inputs.
- Produces: a valid `context-eval-v1` corpus with at least exact-target, relationship/change, and incomplete/ambiguity for every current production language, focused historical edge cases, and approximately four to five small ecosystems.

- [ ] **Step 1: Write failing content tests.** Assert the matrix is generated/validated against `LANGUAGE_CONFIGS`, each case has manually reviewed truth, snapshot paths are bounded, every snapshot has commit/license/path/language/reason metadata, and required license notices are present when required.
- [ ] **Step 2: Run RED.** `node --import tsx/esm --test test/phase15d-corpus-content.test.ts`; expect missing manifest, baseline, and fixture data.
- [ ] **Step 3: Add reviewed data.** Create synthetic source minimally for each registry language and class. Select snapshot source through a separate reproducible maintenance step that records the actual repository and commit SHA; copy only reviewed included paths and notices into the repository. Do not invent source repository names, commit SHAs, licenses, or contents in the plan or evaluator.
- [ ] **Step 4: Run GREEN.** Repeat the command and the full integrity tests; expect complete language/class and provenance/license validation.
- [ ] **Step 5: Commit.** `git add eval/context/corpus eval/context/baselines/context-eval-v1.json test/phase15d-corpus-content.test.ts && git commit -m "test(eval): add reviewed Phase15D corpus"`.

### Task 10: Package scripts, artifact ignore, and CI release gate

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `.github/workflows/context-eval.yml`
- Create: `test/phase15d-integration.test.ts`

**Interfaces:**
- Consumes: `runContextEval`, `updateContextBaseline`, and existing npm/CI conventions.
- Produces: `npm run eval:context` mapped to the normal runner and `npm run eval:context:update-baseline` mapped to the developer workflow; CI runs the normal command offline and uploads the transient reports without modifying baseline/truth.

- [ ] **Step 1: Write failing integration tests.** Assert package scripts exist without removing existing scripts, the report path is ignored, normal evaluation does not change tracked corpus/baseline files, and a non-zero evaluator status blocks the CI job.
- [ ] **Step 2: Run RED.** `node --import tsx/esm --test test/phase15d-integration.test.ts`; expect script/entrypoint failures.
- [ ] **Step 3: Implement.** Add only the two package scripts, ignore only the generated report artifact, and add a CI job using a clean checkout with network disabled. Keep release publication steps separate; do not add `code-atlas eval`, MCP tools, or network setup.
- [ ] **Step 4: Run GREEN.** `node --import tsx/esm --test test/phase15d-integration.test.ts`; expect package and artifact assertions to pass.
- [ ] **Step 5: Commit.** `git add package.json .gitignore .github/workflows/context-eval.yml test/phase15d-integration.test.ts && git commit -m "ci(eval): add Phase15D release gate"`.

### Task 11: Full acceptance, repeated-run verification, and regression comparison

**Files:**
- Create: `test/phase15d-acceptance.test.ts`
- Modify: no production files; existing API contract defects are reported as blockers for a separate approved scope decision.

**Interfaces:**
- Consumes: both npm scripts, the complete corpus/baseline, all evaluator modules, and existing Phase15A/B/C tests.
- Produces: reproducible acceptance evidence and a fresh full-suite baseline comparison; it does not alter production behavior.

- [ ] **Step 1: Record the fresh baseline.** On the implementation branch, run `npm test`, record exact pass/fail test names and environment failures, then run the focused Phase15A/B/C suites separately. Do not assume a historical failure count.
- [ ] **Step 2: Write failing acceptance tests.** Cover corpus integrity, all supported-language coverage, truth/baseline immutability, offline execution, independent clean-run semantic equality, conditional `planIdentity`, reconstruction, uncertainty/authority, lifecycle restart/reuse, workspace isolation, both quality gates, baseline missing/orphan/version failures, candidate diff/`--write`, deterministic machine report excluding timing, exit code, build, lint, typecheck, and existing regression suite invocation.
- [ ] **Step 3: Run RED.** `node --import tsx/esm --test test/phase15d-acceptance.test.ts`; expect failures for any unimplemented acceptance contract.
- [ ] **Step 4: Run GREEN and repository verification.** Run `npm run eval:context`, twice independently; compare semantic reports; run `npm run build`, `npm run lint`, `npx tsc --noEmit`, `npm test`, and the focused Phase15A/B/C commands. Classify exact failures against the fresh baseline; do not call environment blockers passes.
- [ ] **Step 5: Review generated state.** Run `git diff --check`, verify only expected evaluator/corpus/package/CI files changed, verify the report artifact is ignored, and confirm no `.codeatlas`, database, model, or cache files are staged.
- [ ] **Step 6: Commit implementation completion.** `git add eval package.json .gitignore .github/workflows/context-eval.yml test/phase15d-*.test.ts && git commit -m "test(eval): verify Phase15D release gates"`.

## Spec coverage self-review

- Purpose/product scope/non-goals: Tasks 1, 8, 10, and 11; no public API, MCP tool, LLM, network, cloud, Docker, GPU, or generic framework is introduced.
- Architecture and production boundaries: Tasks 2, 3, 6, and 10 use existing production APIs and isolated harness modules.
- Corpus contract and synthetic matrix: Tasks 1 and 9 validate exact schemas and registry-derived three-class coverage.
- Frozen snapshots/provenance/licensing: Task 9 stores only reviewed source and executable provenance/license checks.
- Workspace isolation/offline execution: Tasks 2, 8, 10, and 11.
- Determinism/normalization and conditional plan identity: Task 3 and Task 11; timing is excluded and hashes are never rewritten.
- Correctness hard gates and Phase15A/B/C invariants: Task 4 and Task 6.
- Quality budgets and exact catastrophic formula: Task 5.
- Version compatibility and raw-byte digests: Tasks 1, 7, and 8.
- Lifecycle metrics/scenarios: Task 6.
- Performance observations/non-blocking behavior: Tasks 3, 7, and 8.
- Human/machine reports and exit semantics: Tasks 7 and 8.
- CI/release integration and artifact handling: Task 10.
- Baseline update safety: Task 8.
- Definition of done and complete regression verification: Task 11.

Self-review checklist before implementation starts:

- [ ] No prohibited placeholder language or undefined evaluator interface remains.
- [ ] No task changes production Phase15A/B/C behavior for evaluator convenience.
- [ ] No second language registry exists.
- [ ] Truth, baseline, policy, report schema, and raw-byte digests remain distinct.
- [ ] Missing, orphan, duplicate, malformed, and incompatible corpus data fail before execution.
- [ ] Correctness, determinism, reconstruction, authority/uncertainty, isolation, catastrophic quality, aggregate quality, and integrity failures all return non-zero.
- [ ] Performance cannot alter PASS/FAIL.
- [ ] Snapshot provenance and applicable license notices are executable validation, not prose-only review.
