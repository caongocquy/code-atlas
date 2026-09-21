# Phase15A — Context-Aware Reads

**Status:** Approved design specification

**Scope:** Durable, local, opt-in context-aware file and exact symbol/read projections. This phase changes only context delivery bookkeeping and projection; it does not add agent memory or lifecycle orchestration.

## 1. Goals and boundaries

Phase15A reduces repeated delivery of the same CodeAtlas-owned source context while preserving exactness, deterministic JSON, and safe rehydration. The feature is opt-in. Existing CLI/MCP callers that do not request context-aware reads retain their current full-read behavior and Phase14G compact/full response contract.

Phase15A does not implement task-context compilation, agent lifecycle adapters, generic memory, semantic/vector memory, cloud synchronization, or cross-agent handoff. It does not alter AtlasStore graph/index truth, graph generations, parser facts, resolver semantics, or reliability calculations.

## 2. Identity contracts

### 2.1 RepositoryIdentity

`RepositoryIdentity` is a deterministic logical identity for one Git repository. For a Git workspace it is derived from validated common Git directory identity (`git rev-parse --path-format=absolute --git-common-dir`, normalized to a real path) and the repository metadata needed to disambiguate a malformed or unavailable result. A worktree-local `.git` file is not sufficient identity by itself.

When Git metadata is unavailable, the fallback is the canonical realpath of the validated repository root. The fallback must not collapse unrelated repositories merely because their files are identical. Repository identity must never contain a process id, generation id, timestamp, absolute source path that differs only by worktree, or content hash as its sole discriminator.

The identity resolver must reject ambiguous or contradictory Git metadata rather than guessing. Its output is a stable serialized identity plus diagnostic state when validation is incomplete.

### 2.2 WorkspaceIdentity

`WorkspaceIdentity` identifies the concrete worktree from its canonical realpath and, when available, validated Git worktree metadata. Two worktrees in one repository share `RepositoryIdentity` but have different `WorkspaceIdentity` values. A workspace path change, failed realpath, or contradictory worktree metadata invalidates reuse and requires rehydration.

Workspace identity is never used as a substitute for repository identity, and repository identity is never used to authorize receipt reuse across worktrees.

### 2.3 SessionIdentity

`SessionIdentity` is explicit and supplied by the opt-in caller. A process id, MCP connection, transport object, or similar incidental relationship must not be inferred as a session. Receipt reuse requires an explicit compatible `sessionId`, repository identity, workspace identity, and context generation. Unknown session identity means no reusable prior receipt.

### 2.4 Bounded subject identity

Phase15A initially supports only:

```ts
type ContextSubject =
  | { kind: "file"; path: string }
  | { kind: "symbol"; path: string; symbolId: string; selectorVersion: string }
  | { kind: "range"; path: string; startLine: number; endLine: number };
```

Paths are repository-relative canonical paths: `/` separators, no `.` or `..`, no leading slash, and no checkout-root prefix. Symbol subjects use the existing stable language-symbol identity; a symbol that cannot be resolved uniquely is not silently converted to a name-based subject. Route/framework entities and arbitrary query result sets are outside the Phase15A subject contract.

`subjectIdentity` is the canonical serialization of `RepositoryIdentity`, `WorkspaceIdentity`, subject kind, and selector fields. Content hashes, receipt ids, context generations, and timestamps are not semantic subject identity.

## 3. ContextSession

The persisted session contract is:

```ts
type ContextSession = {
  sessionId: string;
  repositoryIdentity: string;
  workspaceIdentity: string;
  consumer?: { kind: string; id: string; version?: string };
  createdAt: string;
  lastSeenAt: string;
  contextGeneration: string;
  schemaVersion: number;
};
```

`sessionId` is explicit, opaque, and unique within the context database. `contextGeneration` belongs only to the context lifecycle and is independent of graph/index generation ids. A new session or explicit context reset creates a new context generation. Updating `lastSeenAt` is bookkeeping, not evidence that the consumer still sees an earlier receipt.

## 4. ContextReceipt and delivered snapshots

The durable receipt contract is:

```ts
type ContextReceipt = {
  receiptId: string;
  sessionId: string;
  repositoryIdentity: string;
  workspaceIdentity: string;
  subject: ContextSubject;
  subjectIdentity: string;
  projectionIdentity: string;
  contextGeneration: string;
  deliveryMode: "full" | "unchanged" | "delta" | "rehydrate";
  deliveredContentIdentity: string;
  snapshotId: string;
  reliability: unknown;
  deliveredAt: string;
  expiresAt?: string;
  priorReceiptId?: string;
  state: "active" | "expired" | "invalid";
  schemaVersion: number;
};

type DeliveredSnapshot = {
  snapshotId: string;
  receiptId: string;
  subjectIdentity: string;
  projectionIdentity: string;
  content: string;
  contentIdentity: string;
  createdAt: string;
  schemaVersion: number;
};
```

The exact delivered snapshot (or a canonical exact reconstructable representation) is mandatory for `delta`. A hash alone cannot generate an exact delta. `reliability` is historical provenance describing the delivery; current reliability must be read from current CodeAtlas state and must never be authorized by a historical receipt.

`projectionIdentity` includes projection name, selector normalization, and projection schema/version. A Phase14G compact/full choice is part of projection identity. Phase15A must not duplicate Phase14G budgeting; it calls the existing projection layer and records the exact resulting payload identity.

## 5. context.db persistence

Context state is stored in the separate `.codeatlas/context.db`, never in AtlasStore graph/index tables. The database owns an independent `contextSchemaVersion` and migration policy. Minimum tables are:

```text
context_metadata(contextSchemaVersion, createdAt, updatedAt)
context_sessions(sessionId PRIMARY KEY, repositoryIdentity, workspaceIdentity,
  consumerJson, createdAt, lastSeenAt, contextGeneration, schemaVersion)
context_snapshots(snapshotId PRIMARY KEY, receiptId, subjectIdentity,
  projectionIdentity, content, contentIdentity, createdAt, schemaVersion)
context_receipts(receiptId PRIMARY KEY, sessionId, subjectIdentity,
  projectionIdentity, contextGeneration, deliveryMode, deliveredContentIdentity,
  snapshotId, reliabilityJson, deliveredAt, expiresAt, priorReceiptId, state,
  schemaVersion)
```

Receipt and snapshot creation is one transaction. A receipt referencing a missing, partial, or mismatched snapshot is invalid and cannot become authoritative. Writes use deterministic canonical JSON and stable keys; process restart must preserve valid sessions, receipts, and snapshots.

Context database open/read/migration/corruption failures are isolated. Normal repository status, indexing, graph, lexical, semantic, CLI, and MCP operations remain usable; an opt-in context-aware read returns `rehydrate`/`full` with a diagnostic rather than failing the repository operation. Context failure must not mutate AtlasStore state.

## 6. TTL and invalidation

TTL controls only whether an earlier delivered context may be reused. Expiration marks the receipt non-reusable or treats it as expired for decision-making; it does not invalidate source, facts, graph, index, or reliability truth and does not mutate repository state.

Reuse is invalidated by any of:

- expired, corrupt, missing, or schema-incompatible context state;
- repository identity mismatch;
- workspace identity mismatch;
- session or context-generation mismatch;
- subject or projection mismatch;
- ambiguous current subject resolution;
- missing prior snapshot;
- current source/index read failure;
- failed exact-delta reconstruction.

## 7. Deterministic mode decision

For an opt-in request, evaluate the following table in order:

| Mode | Required proof | Result |
| --- | --- | --- |
| `full` | No compatible prior receipt exists for this subject/projection, including the first read in a new session | Complete current payload and new receipt/snapshot |
| `unchanged` | Compatible active session; exact subject/projection match; receipt visibility remains valid; current content identity equals delivered identity | Compact unchanged metadata and new receipt linkage as defined by the implementation |
| `delta` | All `unchanged` compatibility checks; exact prior snapshot and exact current snapshot; deterministic delta; reconstruction invariant passes | Exact delta plus receipt/snapshot for current payload |
| `rehydrate` | A prior receipt was considered but any expiry, corruption, mismatch, ambiguity, missing snapshot, current-read failure, or reconstruction failure prevents safe reuse | Complete current payload, reason/diagnostic, and new receipt/snapshot |

`full` for a genuinely new subject is distinct from `rehydrate` after failed reuse. Neither mode may claim a previous context was visible when that cannot be proven.

## 8. Exact delta invariant

An emitted delta is valid only when:

```text
apply(previousDeliveredPayload, delta) == currentPayload
AND identity(reconstructedPayload) == currentExpectedContentIdentity
```

Both equality checks use canonical serialization/content identity. A semantic, approximate, line-only, or Git-based diff is not sufficient. If either check fails, return `rehydrate`; never emit a guessed `delta`.

## 9. Read integration and compatibility

The core read service remains the source of current content and current reliability. A narrow context-aware read service wraps it:

```ts
readContextAware(repoPath: string, request: {
  sessionId: string;
  contextGeneration: string;
  subject: ContextSubject;
  projection: string;
  ttlSeconds?: number;
}): Promise<ContextAwareReadResult>
```

Legacy reads do not consult or write context receipts. Opt-in CLI/MCP adapters call the wrapper and then the existing presentation/projection layer. MCP responses remain protocol-only and use deterministic JSON; CLI human rendering may remain presentation-specific. No existing MCP tool is retrofitted merely to expose context memory.

## 10. Reliability and uncertainty

Current source/index/reliability state is authoritative for the current read. Historical receipt reliability is provenance only. `mayBeIncomplete`, ambiguity, unknown, stale, unsupported, and confidence fields must survive the context-aware projection. An incomplete current source/index read cannot be represented as authoritative unchanged content. Missing context state is uncertainty and causes safe rehydration, not a negative claim that the content did not change.

## 11. Worktree Isolation audit requirement

Before implementation closes, audit the identity boundary with at least:

1. two worktrees from one Git repository with identical files: shared `RepositoryIdentity`, distinct `WorkspaceIdentity`, no receipt reuse across worktrees;
2. two unrelated repositories with identical files: distinct `RepositoryIdentity` values and no receipt reuse;
3. a normal repository, Git worktree, and non-Git directory: deterministic identities and explicit fallback/diagnostic behavior;
4. relocated or symlinked workspace paths: canonical realpath behavior and safe invalidation;
5. malformed/missing `.git` metadata: fail-safe rehydrate without mutating graph/index state;
6. process restart: valid context state remains readable while corrupted context state is isolated;
7. concurrent sessions/worktrees: no cross-session or cross-worktree receipt leakage.

The audit must record commands, identity values (with local paths sanitized in reports), reuse decisions, and whether context.db remained separate from AtlasStore. It must not add lifecycle adapters or infer agent state.

## 12. Metrics

Track context-aware reads with deterministic counters: requested/returned bytes and token estimates, `fullReads`, `unchangedReads`, `deltaReads`, `rehydrates`, saved bytes/tokens, rehydration rate, and delta efficiency. Metrics are observational and cannot change mode decisions or reliability.

## 13. Conformance requirements

Implementation is conformant only if it proves:

- repository/workspace/session identity separation and stable canonicalization;
- first-read `full`, safe `unchanged`, exact `delta`, and failed-reuse `rehydrate` behavior;
- exact reconstruction and content identity checks;
- atomic receipt/snapshot persistence and restart survival;
- TTL affects reuse only;
- corruption/failure isolation from graph/index functionality;
- legacy reads remain unchanged;
- Phase14G compact/full projection is reused rather than duplicated;
- reliability and incomplete/ambiguous state remain visible;
- read subjects are bounded and exact;
- worktree isolation audit passes;
- context generation is independent from graph/index generation;
- no source-text reparsing, guessed symbol identity, generic memory, or lifecycle inference is introduced.

## 14. Explicit non-goals

- Phase15B task context compiler;
- Phase15C agent lifecycle adapters;
- Phase15D evaluation platform;
- generic agent memory or conversation memory;
- semantic/vector memory;
- cloud synchronization;
- automatic harness state inference;
- cross-agent handoff/checkpoint system;
- arbitrary query-result/session memory;
- broad retrofit of existing MCP tools;
- changes to graph/index/resolver/framework semantics.
