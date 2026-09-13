# Phase15C Task Context Lifecycle Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a durable task-context lifecycle that orchestrates Phase15B context selection with Phase15A incremental delivery across refreshes and process restarts.

**Architecture:** Add a dedicated lifecycle service above the stateless Phase15B compiler and Phase15A delivery primitives. Store lifecycle state in .codeatlas/context.db and refactor Phase15A internally into prepare/commit so refresh can publish receipts and snapshots with an optimistic revision CAS.

**Tech Stack:** TypeScript, Node.js 22+, node:sqlite, MCP SDK, Zod, and the existing CodeAtlas CLI/test stack.

**Spec:** docs/superpowers/specs/2026-09-13-phase15c-task-context-lifecycle-design.md

## Global Constraints

- Phase15B does not own sessions or become stateful.
- ContextSession does not gain task-lifecycle semantics.
- Persistence remains the repository-local .codeatlas/context.db.
- Phase15C uses a dedicated lifecycle table rather than extending context_sessions with task-specific columns.
- taskContextId is a random opaque execution-lifecycle UUID.
- taskIntentIdentity is a Phase15C identity derived from normalized immutable task text, normalized immutable anchors, and an explicit Phase15C intent-identity schema/version.
- TaskContextPlan.taskIdentity follows unchanged Phase15B task-v1 semantics, including normalized changedPaths, and may change on refresh.
- planIdentity is the concrete Phase15B plan identity and may change across refresh.
- sessionId and contextGeneration remain stable during normal refresh.
- task and anchors are immutable after start.
- changedPaths are compiler input for a refresh, not immutable lifecycle state.
- A refresh budget override is one-operation-only and does not mutate defaultBudget, ttlSeconds, taskIntentIdentity, or taskContextId.
- ttlSeconds is a positive bounded integer, defaults to 86400 seconds, is persisted at start, and is immutable for the lifecycle.
- Refresh uses expiresAt = now + persisted ttlSeconds; it never reconstructs the duration from timestamps.
- Lifecycle lookup is scoped to the current resolved workspace's local <worktree>/.codeatlas/context.db.
- A handle absent from that database returns lifecycle_not_found; no global database, repository-shared registry, sibling-worktree scan, or cross-worktree discovery is allowed.
- Only a refresh holding a valid active expected revision may commit deliveries.
- If a revision CAS fails, the losing operation writes zero receipts or snapshots.
- detail compact/full controls lifecycle/compiler diagnostic projection only and never truncates or alters exact Phase15A content or delta delivery.
- Existing compile_task_context, context_read, compileTaskContext(), and readContextAware() remain available with no breaking semantics.
- compileTaskContextForRepository(repoPath, input, deps?) is the sole high-level Phase15B composition boundary for MCP compile_task_context, CLI context-compile, and lifecycle; the low-level compileTaskContext(input, compilerDeps) remains unchanged.
- Phase15C v1 does not add task_context_runs, event sourcing, agent memory, cross-worktree continuation, auto-rebind, a workflow engine, or Phase15D expansion.

---

## File responsibility map

| File | Responsibility |
| --- | --- |
| src/core/context/task-context-lifecycle.types.ts | Lifecycle state, inputs, results, delivery union, metrics, persistence, and structured-error contracts. |
| src/core/context/task-context-lifecycle-identity.ts | taskIntentIdentity, lifecycle input validation, TTL normalization, and handle validation. |
| src/core/context/context-delivery-preparation.ts | Phase15A-neutral non-persisting preparation contract, subject-local preparation errors, operation-local metrics, and single-delivery commit adapter; imports no Phase15C types. |
| src/core/context/context.types.ts | Shared stable Phase15A lifecycle projection constant: source-v1. |
| src/core/context/context-aware-read.service.ts | Existing public read behavior delegating to prepare plus the existing single-delivery commit. |
| src/core/context/task-context-lifecycle-changes.ts | Only current working-tree changed-path capture and normalization over readGitChanges. |
| src/core/context/task-context-repository-compiler.ts | Single repository-level adapter that composes the existing Phase15B compiler pipeline for MCP, CLI context-compile, and lifecycle callers, with an internal typed index-required boundary. |
| src/core/context/task-context-lifecycle.service.ts | Start, refresh, close, expiry, commit-time checks, and orchestration. |
| src/storage/context/context.schema.ts | Additive transactional v1-to-v2 migration, lifecycle table, and internal UnsupportedContextSchemaError. |
| src/storage/context/context.store.ts | Lifecycle load/create, prepared publication, revision CAS, close CAS, expiry CAS, and internal ContextStoreOpenError boundary; generic storage construction remains lifecycle-neutral. |
| src/adapters/mcp/mcp-server.ts | Strict Zod schemas and handlers for lifecycle MCP tools. |
| src/adapters/cli/context-lifecycle.command.ts | Thin lifecycle CLI parsing, JSON output, and human presentation. |
| src/adapters/cli/context-compile.command.ts | Existing context-compile CLI routed through the shared repository compiler adapter while preserving index-required failures. |
| src/adapters/cli/context-read.command.ts | Existing context-read CLI uses the shared source projection constant without changing output/error behavior. |
| src/cli.ts | Lifecycle command routing. |
| src/adapters/cli/cli-help.ts | Lifecycle command help. |
| src/adapters/cli/cli-command-reporter.ts | Lifecycle command reporter labels if required by its union. |
| test/phase15c-lifecycle-identity.test.ts | Intent identity, TTL, budget, and input validation. |
| test/phase15c-context-schema.test.ts | Migration, preservation, rollback, and unsupported-version behavior. |
| test/phase15c-context-store.test.ts | Lifecycle persistence and deterministic CAS state transitions. |
| test/phase15c-context-preparation.test.ts | Prepare/commit extraction and Phase15A compatibility. |
| test/phase15c-changed-paths.test.ts | Working-tree path capture, normalization, ordering, and isolation. |
| test/phase15c-lifecycle-service.test.ts | Start, refresh, close, partial results, and deterministic races. |
| test/phase15c-cli-mcp.test.ts | MCP schemas, structured errors, CLI parsing, and parity. |
| test/phase15c-smoke.test.ts | Real repository, process restart, changed delivery, and second-worktree smoke. |

## Cross-task contracts

Task 1 defines these names in task-context-lifecycle.types.ts. Later tasks consume them without renaming:

~~~ts
import { CONTEXT_AWARE_SOURCE_PROJECTION } from "./context.types.js";
import type { ContextAwareReadResult, ContextReceipt, ContextSession, ContextSubject, DeliveredSnapshot } from "./context.types.js";
import type { ContextAwareReadRequest } from "./context-aware-read.service.js";
import type { ContextDeliveryPreparationDeps, PreparedContextAwareRead } from "./context-delivery-preparation.js";
import type { TaskContextAnchor, TaskContextPlanDetail, CompileTaskContextInput } from "./task-context.types.js";
import type { ContextStore } from "../../storage/context/context.store.js";
import type { loadIndexedGraphReadOnly } from "../graph/indexed-graph.service.js";
import type { getRepositoryStatus } from "../repository/repository-status.service.js";
import type { searchLexical } from "../lexical/lexical-search.service.js";
import type { inspectHybridSearch } from "../retrieval/hybrid-search.service.js";
import type { inspectChange } from "../change/inspect-change.service.js";
import type { analyzeImpact } from "../graph/query/impact.service.js";
import type { affectedTests } from "../change/affected-tests.service.js";

export type TaskContextLifecycleState = "active" | "closed" | "expired";
export type TaskContextLifecycleBudget = {
  maxItems: number;
  maxEstimatedTokens: number;
};
export type TaskContextLifecycle = {
  taskContextId: string;
  repositoryIdentity: string;
  workspaceIdentity: string;
  sessionId: string;
  contextGeneration: string;
  task: string;
  anchors: TaskContextAnchor[];
  taskIntentIdentity: string;
  latestTaskIdentity?: string;
  defaultBudget: TaskContextLifecycleBudget;
  ttlSeconds: number;
  latestPlanIdentity?: string;
  revision: number;
  state: TaskContextLifecycleState;
  createdAt: string;
  lastSeenAt: string;
  expiresAt?: string;
  closedAt?: string;
  schemaVersion: number;
};
export type TaskContextLifecycleMetrics = {
  selectedItems: number;
  deliveredItems: number;
  fullItems: number;
  deltaItems: number;
  unchangedItems: number;
  rehydratedItems: number;
  failedItems: number;
  requestedBytes: number;
  returnedBytes: number;
  savedBytes: number;
  previousPlanIdentity?: string;
  currentPlanIdentity: string;
  planChanged: boolean;
};
export type TaskContextLifecycleOperationErrorCode =
  | "lifecycle_not_found" | "invalid_task_context_id"
  | "task_context_closed" | "task_context_expired"
  | "lifecycle_conflict" | "repository_mismatch"
  | "workspace_mismatch" | "context_database_unavailable"
  | "unsupported_context_schema"
  | "compiler_validation_failed";
export type TaskContextLifecycleOperationError = {
  code: TaskContextLifecycleOperationErrorCode;
  message: string;
  retryable: boolean;
  taskContextId?: string;
  expectedRevision?: number;
  currentRevision?: number;
};
export class TaskContextLifecycleDomainError extends Error {
  readonly payload: TaskContextLifecycleOperationError;
  constructor(payload: TaskContextLifecycleOperationError) {
    super(payload.message);
    this.name = "TaskContextLifecycleDomainError";
    this.payload = payload;
  }
}
export type TaskContextDeliveryErrorCode =
  | "subject_unavailable"
  | "symbol_resolution_failed"
  | "delivery_preparation_failed";
export type TaskContextDeliveryError = {
  code: TaskContextDeliveryErrorCode;
  message: string;
};
export class TaskContextDeliveryDomainError extends Error {
  readonly payload: TaskContextDeliveryError;
  constructor(payload: TaskContextDeliveryError) {
    super(payload.message);
    this.name = "TaskContextDeliveryDomainError";
    this.payload = payload;
  }
}
export type TaskContextDelivery =
  | { mode: "full" | "rehydrate"; subject: ContextSubject; receiptId: string; reliability: unknown; content: string; reason?: string }
  | { mode: "delta"; subject: ContextSubject; receiptId: string; reliability: unknown; delta: unknown }
  | { mode: "unchanged"; subject: ContextSubject; receiptId: string; reliability: unknown }
  | { mode: "error"; subject: ContextSubject; error: TaskContextDeliveryError };
export type TaskContextRepositoryCompilerDeps = {
  loadIndexedGraphReadOnly: typeof loadIndexedGraphReadOnly;
  getRepositoryStatus: typeof getRepositoryStatus;
  searchLexical: typeof searchLexical;
  inspectHybridSearch: typeof inspectHybridSearch;
  inspectChange: typeof inspectChange;
  analyzeImpact: typeof analyzeImpact;
  affectedTests: typeof affectedTests;
};
export type TaskContextRepositoryCompiler = (
  repoPath: string,
  input: CompileTaskContextInput,
  deps?: Partial<TaskContextRepositoryCompilerDeps>,
) => Promise<TaskContextPlanDetail>;
export type TaskContextLifecycleResult = {
  lifecycle: TaskContextLifecycle;
  plan: TaskContextPlanDetail;
  deliveries: TaskContextDelivery[];
  partial: boolean;
  metrics: TaskContextLifecycleMetrics;
};
export type StartTaskContextInput = {
  repoPath?: string;
  task: string;
  anchors?: TaskContextAnchor[];
  budget?: { maxItems?: number; maxEstimatedTokens?: number };
  ttlSeconds?: number;
  detail?: "compact" | "full";
};
export type RefreshTaskContextInput = {
  repoPath?: string;
  taskContextId: string;
  budget?: { maxItems?: number; maxEstimatedTokens?: number };
  detail?: "compact" | "full";
};
export type CloseTaskContextInput = { repoPath?: string; taskContextId: string };
export type CloseTaskContextResult = { lifecycle: TaskContextLifecycle };

export type TaskContextLifecycleDeps = {
  now: () => string;
  openStore: (repoPath: string) => ContextStore;
  readChangedPaths: (repoPath: string) => Promise<string[]>;
  compile: TaskContextRepositoryCompiler;
  prepare: (repoPath: string, request: ContextAwareReadRequest, deps: ContextDeliveryPreparationDeps) => Promise<PreparedContextAwareRead>;
};
~~~

Persistence signatures:

~~~ts
export type TaskContextLifecyclePersistence = {
  createAndCommitStart(input: {
    lifecycle: TaskContextLifecycle;
    session: ContextSession;
    prepared: Array<{ session: ContextSession; receipt: ContextReceipt; snapshot: DeliveredSnapshot }>;
  }): TaskContextLifecycle;
  loadLifecycle(taskContextId: string): TaskContextLifecycle | undefined;
  commitRefresh(input: {
    taskContextId: string;
    expectedRevision: number;
    now: string;
    repositoryIdentity: string;
    workspaceIdentity: string;
    prepared: Array<{ session: ContextSession; receipt: ContextReceipt; snapshot: DeliveredSnapshot }>;
    latestTaskIdentity: string;
    latestPlanIdentity: string;
  }): TaskContextLifecycle;
  closeLifecycle(input: {
    taskContextId: string;
    expectedRevision: number;
    now: string;
    repositoryIdentity: string;
    workspaceIdentity: string;
  }): TaskContextLifecycle;
  expireLifecycle(input: {
    taskContextId: string;
    expectedRevision: number;
    now: string;
    repositoryIdentity: string;
    workspaceIdentity: string;
  }): TaskContextLifecycle;
};
~~~

taskIntentIdentity is task-intent-v1:<sha256>, over canonical JSON containing only schemaVersion 1, normalized task text, and normalized immutable anchors. changedPaths, budgets, capability state, compiler timing, session IDs, receipt IDs, repository/index generations, and plan output are excluded.

The existing ContextAwareReadRequest is owned by
src/core/context/context-aware-read.service.ts and is imported type-only; it is
not moved into context.types.ts. It has a projection string and the current
readContextAware() path uses source-v1. Phase15C lifecycle start and refresh
must use the shared CONTEXT_AWARE_SOURCE_PROJECTION constant from
src/core/context/context.types.ts, whose value is exactly source-v1. detail
compact/full is a separate lifecycle/compiler diagnostic projection and never
changes this Phase15A delivery projection.

Phase15A exposes a neutral preparation contract from the context layer:
ContextDeliveryPreparationMetrics contains requestedBytes, returnedBytes, and
savedBytes; ContextDeliveryPreparationError has the subject-local codes
subject_unavailable, symbol_resolution_failed, or delivery_preparation_failed;
and PreparedContextAwareRead carries session, receipt, snapshot, the exact
Phase15A ContextAwareReadResult (including mode/content/delta/reason), and
operation-local metrics. None of these types imports TaskContextDelivery,
TaskContextDeliveryDomainError, or task-context-lifecycle.types.ts. Lifecycle
maps only known ContextDeliveryPreparationError values into its Phase15C
delivery union; DB/schema/programming failures propagate as hard failures.

Its exact shape is:

~~~ts
export type ContextDeliveryPreparationMetrics = {
  requestedBytes: number;
  returnedBytes: number;
  savedBytes: number;
};
export type ContextDeliveryPreparationDeps = {
  store: Pick<ContextStore, "findLatestReceipt" | "getSnapshot">;
  now: () => string;
};
export type ContextDeliveryPreparationErrorCode =
  | "subject_unavailable"
  | "symbol_resolution_failed"
  | "delivery_preparation_failed";
export class ContextDeliveryPreparationError extends Error {
  readonly code: ContextDeliveryPreparationErrorCode;
  constructor(code: ContextDeliveryPreparationErrorCode, message: string) {
    super(message);
    this.name = "ContextDeliveryPreparationError";
    this.code = code;
  }
}
export type PreparedContextAwareRead = {
  session: ContextSession;
  receipt: ContextReceipt;
  snapshot: DeliveredSnapshot;
  result: ContextAwareReadResult;
  metrics: ContextDeliveryPreparationMetrics;
};
export function prepareContextAwareRead(
  repoPath: string,
  request: ContextAwareReadRequest,
  deps?: ContextDeliveryPreparationDeps,
): Promise<PreparedContextAwareRead>;
export function commitPreparedContextDelivery(
  store: ContextStore,
  prepared: PreparedContextAwareRead,
): void;
~~~

The shared repository compiler adapter is the only high-level Phase15B
composition boundary. Its exact public signature is
compileTaskContextForRepository(repoPath: string, input: CompileTaskContextInput,
deps?: Partial<TaskContextRepositoryCompilerDeps>):
Promise<TaskContextPlanDetail>. It resolves the workspace/repository identities,
indexed graph, status, lexical/hybrid search, change inspection, impact,
affected-tests, candidate collection, and enrichment, then calls the existing
low-level compileTaskContext(input, compilerDeps) unchanged. The MCP
compile_task_context handler, CLI context-compile command, and Phase15C
lifecycle service all call this adapter; none manually rebuilds the pipeline.
Tests inject this same
TaskContextRepositoryCompiler contract. The adapter translates the existing
missing-index condition into an internal typed repository-compiler error (for
example index_required) and does not depend on McpToolError; MCP maps it to
its existing index_required response, CLI preserves its current failure
behavior, and lifecycle maps it to its approved operation error contract.

TaskContextDeliveryMetrics are operation-local: preparation returns neutral
requested, returned, and saved byte counts with each prepared result. Lifecycle service
aggregates those values and mode counts only from its own operation, including
typed per-subject errors. The legacy readContextAware() path records its normal
single-delivery metrics in the existing getContextMetrics()/resetContextMetrics()
global API, without allowing lifecycle operations to mutate or read that global
snapshot. Concurrent lifecycle operations therefore cannot affect one another's
metrics.

## Task 1: Define lifecycle contracts, intent identity, and validation

**Files:**

- Create: src/core/context/task-context-lifecycle.types.ts
- Create: src/core/context/task-context-lifecycle-identity.ts
- Modify: src/core/context/task-context-budget.ts
- Test: test/phase15c-lifecycle-identity.test.ts

**Interfaces:**

- Consumes: TaskContextAnchor, normalizeTaskContextInput(), and defaults from src/core/context/task-context-budget.ts.
- Produces: createTaskIntentIdentity(task: string, anchors: readonly TaskContextAnchor[]): string; normalizeLifecycleTtlSeconds(value: number | undefined): number; normalizeLifecycleBudget(value: { maxItems?: number; maxEstimatedTokens?: number } | undefined): TaskContextLifecycleBudget; validateTaskContextId(value: unknown): string; all cross-task types above; start/refresh/close reject with TaskContextLifecycleDomainError carrying TaskContextLifecycleOperationError.

- [ ] Step 1: Write the failing test. Assert identical normalized task/anchors produce the same task-intent-v1 digest, changed paths cannot affect it, and the digest matches /^task-intent-v1:[0-9a-f]{64}$/. Assert undefined TTL is 86400, 2592000 is accepted, 0, 2592001, and 1.5 are rejected. Assert lifecycle budget normalization and budgetTaskContext() both use the exported Phase15B defaults of 20 items and 4000 estimated tokens.
- [ ] Step 2: Run RED: node --import tsx/esm --test test/phase15c-lifecycle-identity.test.ts. Expected: missing-module or missing-export failure.
- [ ] Step 3: Export DEFAULT_TASK_CONTEXT_BUDGET = { maxItems: 20, maxEstimatedTokens: 4000 } from task-context-budget.ts and add resolveTaskContextBudget(request?) there. Make budgetTaskContext() use that helper, then implement the minimum identity and validation functions. Reuse Phase15B normalization but never call or alter createTaskIdentity() for the Phase15C digest.
- [ ] Step 4: Run GREEN: node --import tsx/esm --test test/phase15c-lifecycle-identity.test.ts test/phase15b-identity.test.ts test/phase15b-normalizer.test.ts.
- [ ] Step 5: Commit: git add src/core/context/task-context-lifecycle.types.ts src/core/context/task-context-lifecycle-identity.ts src/core/context/task-context-budget.ts test/phase15c-lifecycle-identity.test.ts && git commit -m "feat: define Phase15C lifecycle contracts"

## Task 2: Add context.db v1-to-v2 migration and lifecycle persistence

**Files:**

- Modify: src/storage/context/context.schema.ts
- Modify: src/storage/context/context.store.ts
- Test: test/phase15c-context-schema.test.ts
- Test: test/phase15c-context-store.test.ts

**Interfaces:**

- Consumes: TaskContextLifecyclePersistence, TaskContextLifecycle, ContextSession, ContextReceipt, DeliveredSnapshot, and existing receipt/snapshot linkage validation.
- Produces: schema version 2; ContextStore.createAndCommitStart(); loadLifecycle(); commitRefresh(); closeLifecycle(); expireLifecycle(); and a transaction-private prepared publication helper. Constructor/open failures throw only typed internal storage errors; CAS lifecycle-state conflicts may throw TaskContextLifecycleDomainError.

- [ ] Step 1: Write failing tests. Create a v1 SQLite fixture with one session, receipt, and snapshot; assert opening it yields schema version 2 and preserves every row. Create a lifecycle fixture and assert a refresh CAS conflict leaves receipt/snapshot counts unchanged. Add rollback coverage by forcing migration DDL/version-update failure and reopening the original v1 fixture.
- [ ] Step 2: Run RED: node --import tsx/esm --test test/phase15c-context-schema.test.ts test/phase15c-context-store.test.ts. Expected: failure because schema v1 has no lifecycle table or migration.
- [ ] Step 3: Add task_context_lifecycles with task_context_id, repository_identity, workspace_identity, session_id, context_generation, task, anchors_json, task_intent_identity, latest_task_identity, max_items, max_estimated_tokens, ttl_seconds, latest_plan_identity, revision, state, created_at, last_seen_at, expires_at, closed_at, and schema_version. Keep all Phase15A tables and rows. Make open migration transactional/idempotent; update metadata to 2 only after success; reject future versions before writes. Introduce typed internal UnsupportedContextSchemaError at the schema boundary and ContextStoreOpenError for other constructor/open failures. ContextStore exposes those internal errors unchanged; lifecycle maps them above storage, without leaking raw database errors through MCP or CLI.
- [ ] Step 4: Implement createAndCommitStart as one transaction: insert lifecycle revision 0, session, and successful `{ session, receipt, snapshot }` publications supplied by the service, update lifecycle to revision 1, reload the committed row, and return that exact TaskContextLifecycle at revision 1. Implement refresh/close/expiry writes with expected revision and active-state predicates, re-reading the row inside the transaction to classify state and identity errors. Throw TaskContextLifecycleDomainError only for lifecycle-state/CAS failures; generic ContextStore construction remains lifecycle-neutral. Never return an operation error as a delivery error or call independent publish() during lifecycle CAS.
- [ ] Step 5: Run GREEN: node --import tsx/esm --test test/phase15c-context-schema.test.ts test/phase15c-context-store.test.ts test/phase15a-context-store.test.ts test/phase15a-snapshot-persistence.test.ts.
- [ ] Step 6: Commit: git add src/storage/context/context.schema.ts src/storage/context/context.store.ts test/phase15c-context-schema.test.ts test/phase15c-context-store.test.ts && git commit -m "feat: persist Phase15C lifecycle state"

## Task 3: Extract Phase15A prepare/commit without changing public reads

**Files:**

- Create: src/core/context/context-delivery-preparation.ts
- Modify: src/core/context/context.types.ts
- Modify: src/core/context/context-aware-read.service.ts
- Modify: src/storage/context/context.store.ts
- Test: test/phase15c-context-preparation.test.ts

**Interfaces:**

- Consumes: ContextAwareReadRequest, ContextAwareReadResult, ContextStore, decideContextMode(), createExactDelta(), and createDeliveredSnapshot().
- Produces: the Phase15A-neutral ContextDeliveryPreparationMetrics, ContextDeliveryPreparationError, and PreparedContextAwareRead contracts for context-layer consumers; the only Phase15C-facing export from Task 3 is CONTEXT_AWARE_SOURCE_PROJECTION = "source-v1". Task 5 owns constructing lifecycle requests with that constant.

- [ ] Step 1: Write failing tests. Prepare a first file delivery and assert it returns full while receipt/snapshot counts stay unchanged. Call public readContextAware twice and assert full then unchanged, then cover delta and rehydrate. Assert the preparation module uses the shared CONTEXT_AWARE_SOURCE_PROJECTION without moving ContextAwareReadRequest ownership.
- [ ] Step 2: Run RED: node --import tsx/esm --test test/phase15c-context-preparation.test.ts. Expected: missing prepare API failure.
- [ ] Step 3: Move source/symbol reads, reliability lookup, previous history, mode decision, exact reconstruction, and proposed receipt/snapshot creation into the preparation module. Preparation performs no writes. Keep unchanged body-free and full/rehydrate content exact. Raise only the Phase15A-neutral ContextDeliveryPreparationError for subject-local failures; database/schema/programming failures remain hard failures. Export CONTEXT_AWARE_SOURCE_PROJECTION as the sole Phase15C-facing projection value; Task 5 uses it when constructing lifecycle read requests.
- [ ] Step 4: Make readContextAware() consume the neutral PreparedContextAwareRead and use the existing single-delivery commit behavior. Catch only typed ContextStoreOpenError/UnsupportedContextSchemaError and preserve the existing rehydrate degradation on store failure. Record its local prepared metrics into the existing legacy global metrics API only for this public read; lifecycle operations use their own metrics.
- [ ] Step 5: Run GREEN: node --import tsx/esm --test test/phase15c-context-preparation.test.ts test/phase15a-context-aware-read.test.ts test/phase15a-context-delta.test.ts test/phase15a-context-decision.test.ts test/phase15a-legacy-read-regression.test.ts test/phase15a-context-failure-isolation.test.ts.
- [ ] Step 6: Commit: git add src/core/context/context-delivery-preparation.ts src/core/context/context.types.ts src/core/context/context-aware-read.service.ts src/storage/context/context.store.ts test/phase15c-context-preparation.test.ts && git commit -m "refactor: prepare context deliveries before commit"

## Task 4: Reuse Git working-tree changes for compiler input

**Files:**

- Create: src/core/context/task-context-lifecycle-changes.ts
- Test: test/phase15c-changed-paths.test.ts

**Interfaces:**

- Consumes: readGitChanges(repoPath, { mode: "working" }) from src/infrastructure/git/git-change-reader.ts and normalizeTaskContextInput().
- Produces: readCurrentChangedPaths(repoPath: string): Promise<string[]>.

- [ ] Step 1: Write failing tests. Fixture a modified tracked file and an untracked text file; assert paths are repository-relative, deduplicated, sorted, and include both. Assert the changed-path helper returns only normalized paths.
- [ ] Step 2: Run RED: node --import tsx/esm --test test/phase15c-changed-paths.test.ts. Expected: missing adapter failure.
- [ ] Step 3: Map readGitChanges(...).files[].path, apply existing Phase15B path normalization, deduplicate, and sort. Do not accept changedPaths in lifecycle refresh input. Keep this file single-purpose: it does not compile plans or define compiler dependencies.
- [ ] Step 4: Run GREEN: node --import tsx/esm --test test/phase15c-changed-paths.test.ts test/phase15b-normalizer.test.ts test/phase15b-identity.test.ts test/phase15b-identity-integration.test.ts test/inspect-change.test.ts.
- [ ] Step 5: Commit: git add src/core/context/task-context-lifecycle-changes.ts test/phase15c-changed-paths.test.ts && git commit -m "feat: capture current lifecycle changed paths"

## Task 5: Implement lifecycle orchestration and commit-time TTL CAS

**Files:**

- Create: src/core/context/task-context-lifecycle.service.ts
- Create: src/core/context/task-context-repository-compiler.ts
- Modify: src/storage/context/context.store.ts
- Test: test/phase15c-lifecycle-service.test.ts

**Interfaces:**

- Consumes: all Task 1 contracts, the Phase15A-neutral PreparedContextAwareRead and ContextDeliveryPreparationError contracts, getWorkspaceIdentity(), canonicalRepositoryPath(), getRepositoryIdentity(), readCurrentChangedPaths(), compileTaskContextForRepository(), prepareContextAwareRead(), CONTEXT_AWARE_SOURCE_PROJECTION, resolveTaskContextBudget(), and ContextStore.
- Produces: startTaskContext(input: StartTaskContextInput, deps?: TaskContextLifecycleDeps): Promise<TaskContextLifecycleResult>; refreshTaskContext(input: RefreshTaskContextInput, deps?: TaskContextLifecycleDeps): Promise<TaskContextLifecycleResult>; closeTaskContext(input: CloseTaskContextInput, deps?: TaskContextLifecycleDeps): Promise<CloseTaskContextResult>.

- [ ] Step 1: Write failing tests. Assert start creates a distinct opaque handle, revision 1, taskIntentIdentity, persisted default budget, and ttlSeconds 86400. Assert two starts with identical task/anchors have distinct handles. Assert refresh preserves intent/session/generation while Phase15B taskIdentity can change with recomputed paths. Assert both start and refresh pass the exact shared source-v1 projection to preparation, and that compiler adapter injection is the repository-level contract.
- [ ] Step 2: Run RED: node --import tsx/esm --test test/phase15c-lifecycle-service.test.ts. Expected: missing service failure.
- [ ] Step 3: Implement the repository compiler adapter around the unchanged low-level compileTaskContext(input, compilerDeps). Reuse the current MCP composition exactly once, including graph/status/search/change/impact/affected-tests/candidate collection/enrichment, and expose compileTaskContextForRepository(repoPath, input, deps?). Then implement start: resolve canonical repo/workspace, validate immutable task/anchors, generate UUID/session/generation, derive intent identity, normalize effective Phase15B budget through resolveTaskContextBudget() and TTL, read current paths, call the shared adapter with those paths, prepare deliveries using CONTEXT_AWARE_SOURCE_PROJECTION, map each successful PreparedContextAwareRead to the storage publication tuple, and call createAndCommitStart. Persist lifecycle revision 0 and atomically finish at revision 1.
- [ ] Step 4: Implement refresh: lookup only the current workspace-local context.db; validate handle, repository/workspace identity, state, and initial TTL; capture current paths; call the same compileTaskContextForRepository(repoPath, input) with stored task/anchors and current paths; use persisted defaultBudget unless overridden for this operation; prepare outside the write transaction using CONTEXT_AWARE_SOURCE_PROJECTION; map successful neutral preparations to storage publication tuples; and call commitRefresh with transaction-time now only.
- [ ] Step 5: Make commitRefresh reload the lifecycle inside its one short SQLite transaction and verify expected revision, active state, identities, and transaction-time now < persisted expiresAt. If elapsed, write ZERO prepared receipts/snapshots, transition active -> expired with the same expected revision/state write, commit that expiry transition, and throw TaskContextLifecycleDomainError with task_context_expired after the transaction commits. Do not call expireLifecycle from inside commitRefresh. If valid, publish successful prepared items, set lastSeenAt = now, calculate expiresAt = now + persisted ttlSeconds, update latestTaskIdentity/latestPlanIdentity, advance revision N -> N+1, and commit.
- [ ] Step 6: Implement closeTaskContext through closeLifecycle. Active becomes closed; closed is idempotent; expired remains expired. A stale refresh after closure/expiry receives TaskContextLifecycleDomainError with the appropriate operation payload and writes no history. Map UnsupportedContextSchemaError to unsupported_context_schema and other typed ContextStoreOpenError failures to context_database_unavailable; wrap compiler hard validation failures as compiler_validation_failed. Catch only ContextDeliveryPreparationError for subject-local partial results and map its neutral code/message into TaskContextDeliveryError; per-item failures use only TaskContextDeliveryError payloads, and all-item failure still returns a valid committed lifecycle result with deliveredItems 0.
- [ ] Step 7: Write deterministic race tests with injected clock, deferred preparation, and store barriers: two refreshes prepare at revision N, one commits, the other rejects with TaskContextLifecycleDomainError.payload.code = lifecycle_conflict and unchanged row counts; refresh versus close has close win and zero stale writes; refresh versus expiry has expiry win and zero stale writes; preparation crossing expiresAt fails at final commit even when the initial TTL check passed, with commitRefresh itself performing the expiry transition and no second expiry transaction. Add a concurrent-operation metrics test proving lifecycle A's local counts/bytes are unchanged when lifecycle B runs concurrently.
- [ ] Step 8: Run GREEN: node --import tsx/esm --test test/phase15c-lifecycle-service.test.ts test/phase15c-context-store.test.ts test/phase15c-context-preparation.test.ts test/phase15a-context-aware-read.test.ts test/phase15b-compiler.test.ts test/phase15b-ranker.test.ts test/phase15b-collection.test.ts.
- [ ] Step 9: Commit: git add src/core/context/task-context-lifecycle.service.ts src/core/context/task-context-repository-compiler.ts src/storage/context/context.store.ts test/phase15c-lifecycle-service.test.ts && git commit -m "feat: orchestrate durable task context lifecycle"

## Task 6: Expose the same lifecycle service through MCP and CLI

**Files:**

- Modify: src/adapters/mcp/mcp-server.ts
- Create: src/adapters/cli/context-lifecycle.command.ts
- Modify: src/adapters/cli/context-compile.command.ts
- Modify: src/adapters/cli/context-read.command.ts
- Modify: src/cli.ts
- Modify: src/adapters/cli/cli-help.ts
- Modify: src/adapters/cli/cli-command-reporter.ts
- Test: test/phase15c-cli-mcp.test.ts

**Interfaces:**

- Consumes: startTaskContext(), refreshTaskContext(), closeTaskContext(), compileTaskContextForRepository(), CONTEXT_AWARE_SOURCE_PROJECTION, lifecycle result types, registerJsonTool(), and existing reporter conventions.
- Produces: MCP start_task_context, refresh_task_context, close_task_context; CLI context-start, context-refresh, context-close.

- [ ] Step 1: Write failing tests. Assert strict MCP schemas accept start task/anchors/budget/ttl/detail, reject refresh task/anchors/changedPaths/session/generation/receipt fields, and return known structured error codes. Assert CLI parsers return exact StartTaskContextInput, RefreshTaskContextInput, and CloseTaskContextInput.
- [ ] Step 2: Run RED: node --import tsx/esm --test test/phase15c-cli-mcp.test.ts. Expected: tools and parser exports are absent.
- [ ] Step 3: Replace the current MCP compile_task_context manual composition and the current CLI context-compile manual composition with compileTaskContextForRepository(repoPath, input, deps?). Preserve current missing-index behavior: the core adapter uses an internal typed index_required repository-compiler error, MCP maps it to its existing McpToolError/index_required response, and CLI preserves its current command failure behavior. Leave low-level compileTaskContext(input, compilerDeps) unchanged. Replace the hardcoded "source-v1" in MCP context_read and CLI context-read with CONTEXT_AWARE_SOURCE_PROJECTION, preserving exact request/output behavior. Catch TaskContextLifecycleDomainError in lifecycle MCP/CLI handlers and serialize its structured operation payload through errorResult()/the CLI JSON error envelope; TaskContextDeliveryDomainError payloads remain per-item mode="error" values and are never converted from operation errors.
- [ ] Step 4: Add thin CLI parsing for repository path, start task/anchors/budget/TTL, positional handle for refresh/close, --json, and --full. Route commands in cli.ts and add help/reporter labels. Keep all identity, path, budget, TTL, persistence, and state logic in the service.
- [ ] Step 5: Run GREEN: node --import tsx/esm --test test/phase15c-cli-mcp.test.ts test/phase15a-cli-mcp.test.ts test/cli-startup.test.ts test/cli-format.test.ts test/phase10-mcp.test.ts.
- [ ] Step 6: Commit: git add src/adapters/mcp/mcp-server.ts src/adapters/cli/context-lifecycle.command.ts src/adapters/cli/context-compile.command.ts src/adapters/cli/context-read.command.ts src/cli.ts src/adapters/cli/cli-help.ts src/adapters/cli/cli-command-reporter.ts test/phase15c-cli-mcp.test.ts && git commit -m "feat: expose Phase15C lifecycle adapters"

## Task 7: Finish acceptance coverage, compatibility, and migration tests

**Files:**

- Modify: test/phase15c-lifecycle-service.test.ts
- Modify: test/phase15c-context-store.test.ts
- Modify: test/phase15c-context-preparation.test.ts
- Modify: test/phase15c-cli-mcp.test.ts
- Create: test/phase15c-smoke.test.ts

**Interfaces:**

- Consumes: all public lifecycle APIs, Phase15A delivery primitives, Phase15B compiler, and existing identity/change fixtures.
- Produces: named tests for every approved acceptance requirement.

- [ ] Step 1: Add/finalize acceptance tests for process-restart continuity, unchanged/no body, exact delta, rehydrate fallback, new subject full, dropped subject omission, item/all-item partial failure, default budget persistence, ephemeral budget override, persisted TTL restart reuse, close idempotency, expired no resurrection, workspace-local lifecycle_not_found, same-workspace identity validation, symlink escape, DB corruption isolation, compact/full exact-delivery parity, and MCP/CLI parity.

~~~ts
test("equivalent independent lifecycles keep exact delivery equal across detail modes", async () => {
  const lifecycleA = await startTaskContext(startInput, deps);
  const lifecycleB = await startTaskContext(startInput, deps);
  await mutateRelevantSourceOnce(repoPath);
  const compact = await refreshTaskContext({ taskContextId: lifecycleA.lifecycle.taskContextId, repoPath, detail: "compact" }, deps);
  const full = await refreshTaskContext({ taskContextId: lifecycleB.lifecycle.taskContextId, repoPath, detail: "full" }, deps);
  assert.deepEqual(compact.deliveries.map(deliveryShape), full.deliveries.map(deliveryShape));
  assert.equal(compact.deliveries.some((item) => item.mode === "unchanged" && "content" in item), false);
  assert.deepEqual(compact.plan.items, full.plan.items);
  assert.deepEqual(compact.plan.budget, full.plan.budget);
  assert.equal(compact.plan.taskIdentity, full.plan.taskIdentity);
  assert.equal(compact.plan.planIdentity, full.plan.planIdentity);
  assert.notDeepEqual(compact.plan.projection, full.plan.projection);
});
~~~
- [ ] Step 2: Run the acceptance tests after Tasks 1–6: node --import tsx/esm --test test/phase15c-lifecycle-service.test.ts test/phase15c-context-store.test.ts test/phase15c-context-preparation.test.ts test/phase15c-cli-mcp.test.ts test/phase15c-smoke.test.ts. Expected: PASS; any failure identifies a regression to return to the responsible Task 1–6 implementation cycle, not a production edit in Task 7.
- [ ] Step 3: Add/finalize acceptance regression tests only after Tasks 1–6. This task has no production files in its Files section and must not modify production code. Its first execution is expected to pass; if a regression exposes a behavior defect, stop this task and return to the owning Task 1–6 cycle, or create a separately scoped fix that explicitly lists and stages the affected production files.
- [ ] Step 4: Run GREEN: node --import tsx/esm --test test/phase15a-*.test.ts test/phase15b-*.test.ts test/phase15c-*.test.ts test/inspect-change.test.ts test/cli-startup.test.ts test/phase10-mcp.test.ts.
- [ ] Step 5: Commit: git add test/phase15c-lifecycle-service.test.ts test/phase15c-context-store.test.ts test/phase15c-context-preparation.test.ts test/phase15c-cli-mcp.test.ts test/phase15c-smoke.test.ts && git commit -m "test: cover Phase15C lifecycle acceptance gates"

## Task 8: Run real-repository smoke and final verification

**Files:**

- Modify: test/phase15c-smoke.test.ts
- Inspect only: src/cli.ts, src/adapters/mcp/mcp-server.ts, src/core/context/task-context-lifecycle.service.ts

**Interfaces:**

- Consumes: built dist/cli.js, lifecycle CLI commands, MCP process boundary, and a second Git worktree fixture.
- Produces: repeatable smoke evidence with tracked user modifications preserved.

- [ ] Step 1: Extend/finalize the already-created smoke around exact commands: npm run build; node dist/cli.js context-start <repo> --task "update auth" --json; context-refresh with the returned handle; modify one relevant file; context-refresh again; restart the MCP/process boundary; refresh again; and invoke refresh from the second worktree.
- [ ] Step 2: Run the final smoke: npm run build && node --import tsx/esm --test test/phase15c-smoke.test.ts. Expected: PASS; failures return to the owning implementation task.
- [ ] Step 3: Use temporary real Git repositories and worktrees sourced from the actual CodeAtlas repository HEAD, isolated outside the user's primary worktree. Snapshot primary git status --short before the smoke and assert it is unchanged after cleanup. Use child-process handles for restart, never broad process killing. Keep the second worktree's separate context.db; its absent handle must return lifecycle_not_found and never resume.
- [ ] Step 4: Run GREEN and final checks:

~~~bash
npm run build
node --import tsx/esm --test test/phase15c-smoke.test.ts
node --import tsx/esm --test test/phase15a-*.test.ts test/phase15b-*.test.ts test/phase15c-*.test.ts
npm run lint
git diff --check
~~~

- [ ] Step 5: Commit: git add test/phase15c-smoke.test.ts && git commit -m "test: verify Phase15C real repository lifecycle"

## Hard gates

~~~text
restart continuity                    100%
cross-worktree false resume             0%
concurrent double-commit                 0%
losing-refresh stray receipts            0%
unchanged subject body resend            0%
immutable task mutation accepted         0%
Phase15A reconstruction invariant      100%
Phase15B required-authority invariant  100%
~~~

## Self-review before implementation handoff

- [ ] Every spec section 1–22 maps to a task or Global Constraints.
- [ ] taskIntentIdentity is distinct from Phase15B taskIdentity; Phase15B task-v1 is untouched.
- [ ] changedPaths are recomputed from readGitChanges(repoPath, { mode: "working" }), normalized, and never accepted by refresh callers.
- [ ] contextGeneration and sessionId remain stable across refresh.
- [ ] Workspace-local lookup returns lifecycle_not_found when the current store has no row and never resumes across worktrees.
- [ ] compact/full changes only lifecycle/compiler diagnostics, never exact delivery content or delta reconstruction.
- [ ] defaultBudget is persisted and refresh overrides are ephemeral.
- [ ] ttlSeconds is validated, persisted, immutable, reused after restart, and never reconstructed from timestamps.
- [ ] The final refresh transaction rechecks expiry and transitions active to expired with zero delivery writes when preparation crossed expiresAt.
- [ ] prepare to CAS prevents stray receipt/snapshot writes.
- [ ] close/expiry CAS prevents stale refresh commits and repeated close is idempotent.
- [ ] v1 to v2 migration preserves history, is transactional/idempotent, and rejects future schema versions.
- [ ] No event sourcing, rebind, agent memory, workflow engine, or Phase15D work appears.
- [ ] Existing low-level APIs and Phase15A/15B tests remain compatible.
- [ ] One shared compileTaskContextForRepository(repoPath, input, deps?) adapter owns the high-level Phase15B composition; MCP compile_task_context, CLI context-compile, and lifecycle use it, while low-level compileTaskContext(input, compilerDeps) remains unchanged.
- [ ] MCP compile_task_context, CLI context-compile, and lifecycle are the only high-level callers and all route through that adapter; current missing-index/index_required behavior and unknown graph-load failures remain observable.
- [ ] Phase15B budget defaults have one source in task-context-budget.ts; lifecycle normalization delegates to resolveTaskContextBudget().
- [ ] ContextAwareReadRequest remains owned by context-aware-read.service.ts; lifecycle and preparation import it type-only, and source-v1 is one shared projection constant.
- [ ] Phase15A preparation imports no TaskContextDelivery, TaskContextDeliveryDomainError, or task-context-lifecycle.types.ts; Task 3 exposes only the shared projection to Phase15C, while Task 5 owns lifecycle request construction.
- [ ] ContextStore construction exposes only internal UnsupportedContextSchemaError/ContextStoreOpenError-style failures; lifecycle mapping happens above storage and no public path parses error messages.
- [ ] createAndCommitStart returns the committed lifecycle row at revision 1; no caller needs an implicit reload to know the committed state.
- [ ] Task 2 has no duplicate steps; Task 6 owns both context-compile/read adapter updates and lists every modified adapter file in its commit command.
- [ ] Lifecycle metrics are operation-local; legacy global metrics remain compatible, and concurrent lifecycle calls cannot cross-contaminate counts or byte totals.
- [ ] Schema/open failures have deterministic typed mapping; only typed subject-local preparation failures become delivery mode="error", while database/programming failures remain hard operation errors.
- [ ] Task 3 is green before Task 5 begins; Task 4 contains no compiler composition; every production file named by a task appears in that task's Files section and commit command.
- [ ] Task 7 is acceptance-only and Task 8 runs finalized smoke tests; neither relies on impossible pre-stack RED assertions or vague production edits.
- [ ] No placeholder language remains.

Plan complete and saved to docs/superpowers/plans/2026-09-13-phase15c-task-context-lifecycle.md. Execute only after explicit user direction, using superpowers:subagent-driven-development or superpowers:executing-plans.
