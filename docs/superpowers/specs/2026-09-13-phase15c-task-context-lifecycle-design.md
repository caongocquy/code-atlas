# Phase15C — Task Context Lifecycle Design

**Status:** Approved design specification

**Scope:** Durable orchestration of Phase15B task-context selection and Phase15A context-aware delivery for one explicit task handle. This document specifies the lifecycle contract only; it does not implement Phase15C or define its implementation plan.

## 1. Purpose / thesis

Phase15A avoids resending context already delivered and owns **how much**
context to deliver. Its primitives are `ContextSession`, `ContextReceipt`,
`DeliveredSnapshot`, and `readContextAware()`.

Phase15B avoids selecting unnecessary context initially and owns **what**
context is relevant. `compileTaskContext()` remains stateless;
`TaskContextPlan.taskIdentity` and `planIdentity` remain compiler identities.

Phase15C makes Phase15A and Phase15B operate as one durable task lifecycle.
CodeAtlas owns lifecycle orchestration and the caller keeps only an opaque
`taskContextId`. The lifecycle survives MCP or process restart.

> Phase15B selects the right context; Phase15A avoids resending it; Phase15C
> makes both mechanisms persist across the task lifecycle.

## 2. Core architecture

Introduce a dedicated `TaskContextLifecycle` layer above Phase15A and Phase15B:

```text
TaskContextLifecycleService
  ├─ compileTaskContext()       // Phase15B: WHAT
  ├─ prepare/read delivery      // Phase15A: HOW MUCH
  └─ ContextStore               // durable state in .codeatlas/context.db
```

Phase15B does not own sessions or become stateful. `ContextSession` does not
gain task-lifecycle semantics. Phase15C does not create a separate global
database, agent framework, workflow engine, daemon, or execution runtime.

Persistence remains the repository-local `.codeatlas/context.db`. Phase15C
uses a dedicated lifecycle table rather than extending `context_sessions` with
task-specific columns.

## 3. Lifecycle model

The conceptual persisted model is:

```ts
type TaskContextLifecycle = {
  taskContextId: string;

  repositoryIdentity: string;
  workspaceIdentity: string;

  sessionId: string;
  contextGeneration: string;

  task: string;
  anchors: TaskContextAnchor[];
  taskIntentIdentity: string;
  latestTaskIdentity?: string;

  defaultBudget: {
    maxItems: number;
    maxEstimatedTokens: number;
  };

  ttlSeconds: number;

  latestPlanIdentity?: string;

  revision: number;
  state: "active" | "closed" | "expired";

  createdAt: string;
  lastSeenAt: string;
  expiresAt?: string;
  closedAt?: string;

  schemaVersion: number;
};
```

The following rules are normative:

- `taskContextId` is a random opaque execution-lifecycle UUID.
- `taskIntentIdentity` is a Phase15C identity derived from normalized immutable
  task text, normalized immutable anchors, and an explicit Phase15C
  intent-identity schema/version. It is stable for the lifecycle.
- `TaskContextPlan.taskIdentity` is the existing Phase15B compile-input
  identity. It follows unchanged Phase15B `task-v1` semantics, including
  normalized `changedPaths`, and may change on refresh when current changes are
  recomputed.
- `planIdentity` is the concrete Phase15B plan identity and may change across
  refresh. `latestTaskIdentity`, if persisted, is audit metadata only and is
  never lifecycle authority.
- `start_task_context` always creates a new lifecycle. Creation is never
  deduplicated by `taskIntentIdentity` or Phase15B `taskIdentity`.
- `sessionId` and `contextGeneration` are created once and remain stable for
  the lifecycle during normal refresh.
- A changed `planIdentity` does not change `contextGeneration`.
- `task` and `anchors` are immutable after start.
- `changedPaths` are compiler input for a refresh, not immutable lifecycle
  state. Each refresh evaluates current repository/worktree changes again.
- A refresh budget override applies only to that refresh and does not mutate
  the lifecycle identity, `taskIntentIdentity`, or `defaultBudget`.
- `ttlSeconds` is the normalized effective lifecycle TTL duration. It is a
  positive bounded integer, defaults to `86400` seconds (24 hours), is persisted
  at start, and is immutable for the lifecycle.
- `latestPlanIdentity` is audit/state metadata only; it is not an identity
  used to deduplicate or authorize a lifecycle.

The identity taxonomy is:

```text
taskContextId       = random opaque execution-lifecycle identity
taskIntentIdentity  = immutable Phase15C identity for task + anchors
taskIdentity        = existing Phase15B compile-input identity, including
                      current normalized changedPaths; may change on refresh
planIdentity        = concrete Phase15B plan identity; may change on refresh
```

## 4. Storage and schema migration

The current context schema v1 moves to schema v2 by an additive,
transactional, backward-safe migration.

Schema v2 must preserve `context_sessions`, `context_receipts`, and
`context_snapshots`, and add `task_context_lifecycles`. Existing v1 rows and
their receipt/snapshot history are not rebuilt, deleted, or rewritten. A v1
database is migrated automatically on open before Phase15C operations run.

The lifecycle table stores the serialized immutable task and anchors,
`taskIntentIdentity`, optional latest Phase15B `taskIdentity`, session and
generation, budget defaults, normalized `ttlSeconds`, latest plan metadata,
revision, state, timestamps, expiry, and row schema version. The database-level
`contextSchemaVersion` becomes `2` only as part of the successful migration
transaction. The migration is idempotent.

If the database declares a future or unsupported schema version, opening it
fails closed with `unsupported_context_schema`. No downgrade, destructive
rewrite, or best-effort interpretation is allowed. Context database failure
must remain isolated from AtlasStore graph/index state.

Phase15C v1 does not add `task_context_runs`, event sourcing, or a persistent
time-series metrics table.

## 5. Public API

The primary agent-facing API is MCP. Existing low-level APIs remain available:

- `compile_task_context`
- `context_read`
- `compileTaskContext()`
- `readContextAware()`

Add lifecycle operations with these conceptual inputs:

```ts
start_task_context({
  repoPath?: string;
  task: string;
  anchors?: TaskContextAnchor[];
  budget?: { maxItems?: number; maxEstimatedTokens?: number };
  ttlSeconds?: number;
  detail?: "compact" | "full";
});

refresh_task_context({
  repoPath?: string;
  taskContextId: string;
  budget?: { maxItems?: number; maxEstimatedTokens?: number };
  detail?: "compact" | "full";
});

close_task_context({
  repoPath?: string;
  taskContextId: string;
});
```

`refresh_task_context` must not accept new task text, new anchors, `sessionId`,
`contextGeneration`, receipt IDs, or caller-provided `changedPaths`.

The CLI mirrors the same service and contains no independent lifecycle
semantics:

```text
code-atlas context-start --task "..."
code-atlas context-refresh <taskContextId>
code-atlas context-close <taskContextId>
```

MCP and CLI differ only in transport/presentation. They use the same service,
validation, persistence, errors, and response semantics.

## 6. Start flow

`start_task_context` performs these steps:

1. Resolve the canonical repository and workspace.
2. Validate task text and anchors using the existing Phase15B/Phase15A
   contracts.
3. Generate a new opaque `taskContextId`.
4. Generate a new stable `sessionId`.
5. Generate a new stable `contextGeneration`.
6. Normalize task and anchors, derive `taskIntentIdentity`, normalize the
   effective default budget using Phase15B defaults, and validate the effective
   `ttlSeconds` as a positive bounded integer. When omitted, use `86400`.
7. Capture current relevant worktree/repository state for compiler input.
8. Compile the stored immutable task and anchors with current `changedPaths`
   through Phase15B. Its `taskIdentity` includes those paths under unchanged
   Phase15B `task-v1` semantics.
9. Prepare Phase15A deliveries for selected subjects.
10. Atomically persist the lifecycle, successful receipts/snapshots, and the
   initial lifecycle state.
11. Return lifecycle metadata, plan, delivery bundle, and operation metrics.

The initial lifecycle revision is explicitly `0`. The lifecycle row is created
with revision `0`; the first successful start commit persists any successful
deliveries and transitions the row to revision `1` in the same transaction.
If start cannot commit the lifecycle, no lifecycle handle is returned. A start
with zero selected subjects still creates a valid lifecycle and commits the
revision transition; it returns an empty delivery bundle with the plan.

## 7. Refresh flow

`refresh_task_context` performs these steps:

1. Resolve the current canonical repository and workspace.
2. Load the lifecycle from that workspace's `context.db`.
3. Verify lifecycle identity, state, and TTL.
4. Record expected revision `N`.
5. Re-evaluate current worktree/repository state.
6. Recompile the same immutable task and anchors. Current change evidence is
   recomputed; it is not read from lifecycle state.
7. Prepare Phase15A delivery decisions for the new selected subjects.
8. Open a short database transaction and re-check the lifecycle at revision
   `N`.
9. If valid, persist successful prepared receipts/snapshots, update plan/TTL,
   and commit revision `N + 1`.
10. Return plan, delivery bundle, and metrics.

A refresh cannot mutate task text, anchors, `taskIntentIdentity`, `sessionId`,
or `contextGeneration`. It recomputes `changedPaths` and may therefore produce
a different Phase15B `taskIdentity`. A changed plan may update latest plan and
task identity audit metadata, successful delivery history, `lastSeenAt`,
`expiresAt`, and revision.

At refresh, no `budget` override uses the persisted effective `defaultBudget`.
A provided budget is a one-operation override only; it does not mutate
`defaultBudget`, `ttlSeconds`, `taskIntentIdentity`, or `taskContextId`.

## 8. Delivery semantics

Phase15B selects the subjects; Phase15A decides delivery for each selected
subject. For an existing unchanged subject, return `unchanged` with no source
body. For an existing changed subject, return an exact `delta` when
reconstruction is valid; otherwise use the normal Phase15A `rehydrate`/full
fallback. A newly selected subject returns `full`. A subject removed from the
new plan produces no delivery.

`taskIdentity` and `planIdentity` may change while `taskContextId`,
`taskIntentIdentity`, `sessionId`, and `contextGeneration` remain unchanged.

The lifecycle response contains lifecycle metadata, plan, `deliveries[]`,
`partial`, and operation metrics. Delivery variants are:

- `full` / `rehydrate`: subject, receipt ID, reliability, and content;
- `delta`: subject, receipt ID, reliability, and exact delta;
- `unchanged`: subject, receipt ID, reliability, and no content;
- `error`: subject and structured error, with no fake receipt.

`detail: "compact" | "full"` controls only lifecycle/compiler diagnostic
projection: identities, bounded plan metadata, evidence, diagnostics, and
omitted-item metadata. It must not truncate, summarize, or otherwise alter
exact Phase15A content or delta delivery. Both details use the same delivery
preparation and exact reconstruction invariant; compact merely omits diagnostic
projection fields. Unchanged deliveries contain no content in either detail.

## 9. Atomic prepare → CAS commit

This is required for concurrency correctness. Phase15A is refactored internally
into conceptual prepare and commit primitives:

```text
prepareContextAwareRead(...)
  read current source
  load previous history
  compute full / unchanged / delta / rehydrate
  create proposed receipt and snapshot
  do not persist

readContextAware(...)
  prepare one delivery
  commit one delivery
  preserve current public behavior
```

Phase15C prepares all deliveries outside a database write transaction, then
opens a short transaction, re-checks that the lifecycle is active, still has
the expected revision `N`, and matches the resolved repository/workspace, and
then persists successful prepared receipts/snapshots plus the lifecycle update.

Filesystem reads, compilation, graph access, and delta reconstruction must not
run while holding a long SQLite write lock. If the revision CAS fails, the
transaction writes no receipts or snapshots from the losing refresh and
returns `lifecycle_conflict` with `retryable: true`.

The start transaction has no competing expected revision: it inserts revision
`0` and atomically commits the initial transition to revision `1`.

## 10. Concurrency

The concurrency boundary is one `taskContextId`, using optimistic revision
control. Different lifecycle IDs may refresh concurrently. Two refreshes of the
same lifecycle at revision `N` result in exactly one commit; the loser receives:

```json
{
  "code": "lifecycle_conflict",
  "retryable": true,
  "taskContextId": "...",
  "expectedRevision": 3,
  "currentRevision": 4
}
```

There is no silent overwrite and no automatic internal retry. The losing
operation leaves zero stray receipts or snapshots.

## 11. Identity and worktree isolation

`repositoryIdentity` is stable across worktrees of the same Git repository.
`workspaceIdentity` is unique to the canonical realpath of the concrete
worktree. A lifecycle is bound to both.

Lifecycle lookup is scoped to the current resolved workspace's local
`<worktree>/.codeatlas/context.db`. A handle absent from that database returns
`lifecycle_not_found`; the service does not use a global database,
repository-shared registry, sibling-worktree scan, or cross-worktree discovery.
If a row is found, refresh and close resolve the current canonical
repository/workspace and compare both persisted identities. A repository
identity mismatch returns `repository_mismatch`; a workspace identity mismatch
returns `workspace_mismatch`. A handle created in worktree A and used from
worktree B therefore normally returns `lifecycle_not_found`, and can never
resume against worktree B. A symlink alias resolving to the same canonical
worktree is allowed. Symlink escape outside the allowed repository or worktree
boundary is rejected.

`taskContextId` is an opaque handle, not path authority. There is no implicit
rebind. Cross-worktree continuation, rebind, and fork APIs are out of scope for
Phase15C v1.

## 12. State machine and TTL

The only states are `active`, `closed`, and `expired`:

```text
start  -> active
active -> closed
active -> expired
```

There are no paused, failed, abandoned, or resuming states.

The default TTL is `86400` seconds (24 hours). At start, `ttlSeconds` is the
normalized effective duration: the supplied value or `86400` when omitted. It
must be a positive bounded integer no greater than `2592000` seconds (30 days),
and the normalized value is persisted with the lifecycle. Start sets
`expiresAt = now + ttlSeconds`; every successful refresh, including a partial
refresh that commits, sets `expiresAt = now + persisted ttlSeconds`. A hard
failure before commit does not extend TTL. Refresh cannot change
`ttlSeconds`, and process restart reads the persisted duration rather than
deriving it from `expiresAt - lastSeenAt`. A one-operation budget override has
no effect on `ttlSeconds`.

Start also persists the effective `defaultBudget` after applying Phase15B
defaults; refresh reuses it unless a one-operation budget override is provided.

On first access after expiry, the lifecycle is atomically marked expired using
an expected state/revision write; the operation returns
`task_context_expired`, `retryable: false`, and never auto-resurrects the
handle.

`close_task_context` changes active to closed using an atomic state/revision-
aware write. Closing an already closed lifecycle is idempotent success.
Closing an expired lifecycle preserves expired state. Close never deletes
receipts, snapshots, sessions, or the lifecycle row.

Refresh, close, and expiry all use the same optimistic revision boundary. Only
a refresh holding a valid active expected revision may commit deliveries. If a
close or expiry transition wins first, a stale refresh CAS fails and writes zero
receipts/snapshots. If a refresh commits first, a later close observes the new
revision and closes it; a later expiry observes the new revision and either
marks it expired when due or leaves it active. No operation silently overwrites
a newer state.

## 13. Partial failure semantics

Hard operation failures are lifecycle not found, invalid handle, repository or
workspace mismatch, closed lifecycle, expired lifecycle, context database or
schema corruption, lifecycle CAS conflict, and compiler hard validation failure.

Per-item failures include source deletion between compile and read, loss of
unique symbol resolution, subject read failure, and subject-local delivery
preparation failure. They do not fail unrelated selected deliveries, do not
create receipts/snapshots for the failed item, and set `partial: true`.

If every selected delivery fails but the lifecycle update itself is valid, the
operation returns a structured partial result with `deliveredItems: 0`; it does
not collapse to a generic `internal_error`.

For a partial refresh, successful item receipts/snapshots and the lifecycle
revision/TTL update commit together. Failed items have no durable receipt.

## 14. Metrics and observability

Each lifecycle operation returns these observational metrics:

```text
selectedItems
deliveredItems
fullItems
deltaItems
unchangedItems
rehydratedItems
failedItems
requestedBytes
returnedBytes
savedBytes
previousPlanIdentity?
currentPlanIdentity
planChanged
```

Metrics are operation-level only. They do not affect mode decisions,
reliability, identity, or persistence beyond the receipts and lifecycle state
already required as audit evidence. No persistent time-series metrics are added
in Phase15C v1.

## 15. Error contract

The service must distinguish at minimum:

```text
lifecycle_not_found
invalid_task_context_id
task_context_closed
task_context_expired
lifecycle_conflict
repository_mismatch
workspace_mismatch
context_database_unavailable
unsupported_context_schema
```

Errors are structured and deterministic. They must not infer all lifecycle
cases from generic SQLite errors. `lifecycle_conflict` is retryable;
`task_context_expired` is not. Per-item errors are attached to the affected
delivery and never contain a fake receipt.

## 16. Compatibility

Existing `compile_task_context`, `context_read`, `compileTaskContext()`, and
`readContextAware()` remain available with no breaking semantics for existing
Phase15A/Phase15B consumers. The internal prepare/commit refactor of
`readContextAware()` is allowed only if its public result behavior remains
compatible.

Phase15C calls the existing compiler and the same context delivery primitives;
it does not duplicate compiler or delivery logic. Legacy low-level calls are
not silently changed to infer or join a task lifecycle.

## 17. Security and safety

The implementation must enforce canonical repository/workspace validation,
realpath boundary checks, symlink escape rejection, opaque lifecycle IDs, and
no arbitrary path authority through a lifecycle handle. It must prevent
cross-worktree resume, avoid fake receipts on failed delivery, isolate context
database corruption, and fail closed for unsupported future schemas.

## 18. Acceptance tests

Required coverage:

- persistence: start, process restart, and refresh using the same handle;
- workspace isolation: a handle used from a different worktree does not resume;
  `lifecycle_not_found` is the normal result for workspace-local stores;
- unchanged subject: no body is resent;
- valid small source change: exact delta when reconstruction passes;
- newly selected subject: full delivery;
- removed subject: no delivery;
- immutable intent: refresh cannot mutate task, anchors, or
  `taskIntentIdentity`;
- plan evolution: Phase15B `taskIdentity` and `planIdentity` may change without
  changing `taskIntentIdentity`, session, or context generation;
- concurrency: two refreshes at one revision produce exactly one commit;
- atomicity: the losing refresh leaves zero stray receipts/snapshots;
- partial failure: one item may fail while unrelated items commit;
- active/closed/expired state semantics;
- sliding TTL and hard-failure TTL behavior, including persisted TTL reuse after
  process restart;
- v1-to-v2 migration preserving existing history;
- future schema rejection;
- symlink and path-boundary safety;
- MCP/CLI parity through the same service;
- Phase15A reconstruction invariant;
- Phase15B required-authority invariant.

## 19. Hard gates

```text
restart continuity                    100%
cross-worktree false resume             0%
concurrent double-commit                 0%
losing-refresh stray receipts            0%
unchanged subject body resend            0%
immutable task mutation accepted         0%
Phase15A reconstruction invariant      100%
Phase15B required-authority invariant  100%
```

## 20. Real-repository lifecycle smoke

The real stack smoke must:

1. Start a task and capture its plan/deliveries.
2. Refresh unchanged and verify reusable subjects become `unchanged` where
   applicable.
3. Modify one relevant file, refresh, and verify changed subjects use
   `delta`/full while unaffected subjects remain `unchanged`.
4. Restart the MCP/process and refresh the same handle, verifying delivery
   history remains reusable.
5. Exercise a second Git worktree and verify the same handle cannot resume;
   `lifecycle_not_found` is the expected result when its local store has no row.

## 21. Non-goals

Phase15C v1 explicitly excludes agent memory, conversation history,
cross-worktree continuation, auto-rebind, lifecycle deduplication by
`taskIntentIdentity` or Phase15B `taskIdentity`, a generic workflow engine,
background daemon behavior, event sourcing, `task_context_runs`, native Read
interception, generic RAG, an LLM
planner, autonomous agent execution, and Phase15D evaluation framework
expansion.

## 22. Design rationale

- A dedicated lifecycle table keeps task ownership separate from Phase15A's
  reusable session contract and avoids task-specific columns in
  `context_sessions`.
- The existing repository-local `context.db` provides restart durability and
  preserves the separation from AtlasStore without introducing a global store.
- An explicit opaque `taskContextId` is safer and more stable than MCP
  connection identity, which is transport/process state and may disappear.
- Immutable task intent makes refresh reproducible and prevents a handle from
  silently changing meaning.
- Lifecycle creation is not deduplicated by `taskIntentIdentity` or Phase15B
  `taskIdentity`: two callers may intentionally inspect the same logical task
  with independent sessions and delivery histories. Phase15B `taskIdentity`
  may also change as refresh recomputes `changedPaths`; it is not lifecycle
  intent authority.
- Stable `contextGeneration` across normal refresh lets Phase15A reuse its
  history while `planIdentity` records concrete plan evolution.
- Prepare → CAS commit is necessary because independent receipt writes before a
  losing revision check would leave stray history.
- Strict workspace isolation prevents context from one checkout being reused
  against another checkout's source. Workspace-local lookup intentionally makes
  `lifecycle_not_found` the normal cross-worktree result rather than adding
  discovery machinery solely to produce a more specific error.
- Event sourcing and a task-run event table are unnecessary until a later phase
  requires replayable execution history; durable lifecycle state plus receipts
  are sufficient for v1.

## Self-review checklist

This specification is ready for implementation planning only after the following
checks pass:

- no unfinished or unresolved design marker remains;
- revision semantics, receipt persistence, partial failures, and TTL do not
  contradict each other;
- start revision `0` insertion and revision `1` initial commit are explicit;
- the prepare/short-transaction/CAS boundary is explicit;
- existing `context_read` behavior remains backward-compatible;
- refresh recomputes current changed-path evidence and does not persist
  `changedPaths` as lifecycle intent; Phase15B `taskIdentity` may change;
- `taskIntentIdentity` is stable and distinct from the Phase15B `taskIdentity`;
- compact/full detail changes only diagnostic projection, never exact delivery
  content or delta reconstruction;
- start persists the effective Phase15B default budget and refresh reuses it
  unless a one-operation override is supplied;
- start persists normalized positive bounded `ttlSeconds`; refresh reuses it
  after restart and never derives its duration from timestamps;
- close and expiry use state/revision-aware CAS writes, so stale refreshes
  cannot commit after closure/expiry;
- Phase15D, cross-worktree continuation, and rebind remain excluded;
- v1-to-v2 migration preserves history and rejects unsupported versions;
- every public lifecycle error has deterministic semantics.
