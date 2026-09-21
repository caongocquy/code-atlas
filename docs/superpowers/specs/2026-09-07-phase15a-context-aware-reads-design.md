# Phase 15A — Context-Aware Reads

**Status:** Proposed design specification

## 1. Goal

Reduce repeated delivery of CodeAtlas-owned code reads within a reliable agent context.

The feature applies first to symbol/range reads and must preserve backward compatibility for clients that do not opt in.

## 2. Modes

### `full`

No reliable prior delivered snapshot exists for the requested source selector.

Return the complete requested content.

### `unchanged`

The exact source selector was previously delivered in the same reliable context generation and its current content hash is identical.

Return compact metadata only; do not resend the body.

### `delta`

A reliable prior delivered snapshot exists in the same context generation, but current content differs.

Return only the minimal structured change plus surrounding context required to interpret the modification.

### `rehydrate`

A previous receipt exists but cannot be trusted as model-visible in the current context generation, or the prior snapshot is unavailable.

Return the complete current requested content again.

## 3. Compatibility

Default:

```text
contextAwareReads = false
-> legacy full-read contract
```

Opt-in:

```text
contextAwareReads = true
-> full | unchanged | delta | rehydrate
```

Do not silently change the response shape for legacy/unknown clients.

## 4. State separation

Repository state remains persistent and authoritative for current source/index content.

Context state is ephemeral and scoped to one client/session/context generation.

```text
Repository state
- repository/worktree
- path
- symbol/range
- current content
- content hash

Context state
- session
- context generation
- receipt
- exact delivered snapshot
- visibility reliability
```

Do not store receipts in graph/index tables.

## 5. Source identity

Identity must distinguish two worktrees even if they contain identical source.

Conceptual identity:

```text
RepositoryIdentity
+ SourceWorkspaceIdentity
+ relative path
+ selector identity
```

Where:

- `RepositoryIdentity` identifies the logical repository/common Git identity.
- `SourceWorkspaceIdentity` identifies the concrete source workspace/worktree, preferably from canonical worktree metadata plus realpath.
- selector is symbol/range/file-range identity.

Content hash alone is never a source identity.

## 6. Receipt model

Conceptual contracts:

```ts
export type ContextGenerationId = string;
export type ContextSessionId = string;
export type ReceiptId = string;

export type SourceSelector =
  | { kind: "symbol"; path: string; symbol: string }
  | { kind: "range"; path: string; startLine: number; endLine: number }
  | { kind: "file"; path: string };

export type DeliveryReceipt = {
  receiptId: ReceiptId;
  sessionId: ContextSessionId;
  contextGenerationId: ContextGenerationId;
  repositoryIdentity: string;
  workspaceIdentity: string;
  selector: SourceSelector;
  contentHash: string;
  createdAt: string;
  visibility: "reliable" | "unknown" | "invalid";
};

export type DeliveredSnapshot = {
  receiptId: ReceiptId;
  content: string;
  selector: SourceSelector;
  contentHash: string;
};
```

V1 may keep snapshots in an in-memory bounded store. A restart/lost snapshot causes `rehydrate`.

## 7. Visibility rule

A server-side receipt is not enough to return `unchanged`.

`unchanged` or `delta` requires:

```text
receipt exists
AND receipt belongs to current session
AND receipt context generation == current context generation
AND visibility is reliable
AND prior snapshot exists when delta is required
```

Otherwise return `rehydrate`.

TTL may expire receipts conservatively but cannot prove model visibility.

## 8. Harness reliability levels

### Trusted lifecycle

Harness provides signals such as:

- session started
- context generation changed
- context compacted
- context reset

CodeAtlas may safely use same-generation receipts.

### Best-effort lifecycle

Harness does not expose reliable compaction/reset signals.

CodeAtlas must be conservative. It may use explicit client lifecycle calls but must rehydrate when receipt visibility cannot be established.

## 9. Delta semantics

Delta baseline is the **exact previously delivered snapshot** for this receipt.

Never diff against:

- Git HEAD
- previous index generation unless that snapshot was exactly delivered
- last committed file
- arbitrary cache content

Conceptual result:

```ts
export type ContextAwareReadResult =
  | { mode: "full"; receipt: DeliveryReceipt; content: string }
  | { mode: "unchanged"; receipt: DeliveryReceipt; previousReceiptId: ReceiptId }
  | { mode: "delta"; receipt: DeliveryReceipt; previousReceiptId: ReceiptId; changes: StructuredDelta[] }
  | { mode: "rehydrate"; receipt: DeliveryReceipt; previousReceiptId?: ReceiptId; content: string; reason: RehydrateReason };
```

Structured delta should contain old/new ranges, changed content, and small surrounding context. Human-facing rendering may use unified diff.

## 10. V1 scope

Supported:

- `read_symbol`
- `read_range`
- explicit session/context reset
- stable content hash detection
- exact delivered snapshot tracking
- worktree-safe identity
- metrics

Whole-file reads in V1:

- `full`
- `unchanged`
- `rehydrate`

Whole-file delta is deferred until bounded range/symbol semantics are proven.

## 11. Conservative edge cases

- Symbol moved/renamed: return `full`/`rehydrate`; no move-aware identity in V1.
- Snapshot evicted: `rehydrate`.
- Context generation mismatch: `rehydrate`.
- Unknown visibility: `rehydrate`.
- Worktree changed: identity mismatch -> `full`.
- Content unchanged but selector changed: `full`.
- Partial parser/index uncertainty does not weaken source delivery correctness; source content remains authoritative for reads.

## 12. Metrics

Track at least:

```text
requestedBytes
returnedBytes
requestedTokensEstimate
returnedTokensEstimate
fullReads
deltaReads
unchangedReads
rehydrates
savedBytes
savedTokensEstimate
rehydrationRate
deltaEfficiency
```

Definitions:

```text
savedTokens = requestedTokensEquivalent - returnedTokens
rehydrationRate = rehydrates / context-aware reads
deltaEfficiency = deltaReturnedTokens / equivalentFullTokens
```

## 13. Non-goals

- persistent agent memory
- arbitrary output deduplication
- terminal/test output compression
- cross-session content assumptions
- move-aware symbol identity
- whole-file delta optimization in first release

## 14. Acceptance criteria

1. First reliable read returns full.
2. Same selector + same content + same reliable context generation returns unchanged.
3. Same selector + changed content + reliable prior snapshot returns delta reconstructing the current content.
4. Context reset/compaction invalidates prior visibility and causes rehydrate.
5. Two worktrees never share receipt visibility accidentally.
6. Legacy client remains full-only.
7. Snapshot loss never produces incorrect unchanged/delta.
8. Existing graph/index semantics remain unchanged.
9. Metrics show significant repeated-context reduction on multi-step edit/read flows.

