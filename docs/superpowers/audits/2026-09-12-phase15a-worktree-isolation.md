# Phase15A Worktree Isolation Audit

**Date:** 2026-09-12
**Scope:** Repository/workspace identity and isolated context receipt reuse.

## Evidence

| Case | Result |
| --- | --- |
| Two Git worktrees from one repository | Same `git-common-v1:<canonical-common-dir>` repository identity; distinct `git-worktree-v1:<canonical-worktree>` workspace identities. Existing path-based `getRepositoryIdentity()` remains unchanged. |
| Two unrelated non-Git repositories with identical files | Distinct canonical-path repository and workspace identities; no content hash is used. |
| Non-Git directory | Filesystem fallback is deterministic and keyed by canonical repository path. |
| Symlink/realpath | Identity uses the existing canonical realpath helper. |
| Malformed `.git` marker | Resolver throws a safe validation error; it does not guess or mutate AtlasStore. |
| Process restart | `context.db` reopens and returns the same session, receipt, and exact snapshot. |
| Receipt corruption | Workspace mismatch is classified as `rehydrate`; the current source is returned and a new receipt is published. Invalid SQLite is reported as an isolated context-database error. |
| Concurrent identity scope | Receipt lookup is constrained by explicit session, subject, and projection; workspace identity is checked before reuse. |

## Commands

```text
node --import tsx/esm --test test/phase15a-identity.test.ts test/phase15a-worktree-isolation.test.ts
node --import tsx/esm --test test/phase15a-context-store.test.ts test/phase15a-context-failure-isolation.test.ts
node --import tsx/esm --test test/phase15a-context-aware-read.test.ts
```

All listed audit tests passed. Temporary repository paths and identity values are intentionally omitted from this report.

## Ownership check

`context.db` contains only `context_metadata`, `context_sessions`, `context_snapshots`, and `context_receipts`. AtlasStore continues to own `.codeatlas/atlas.db`; no AtlasStore schema, graph generation, index generation, parser facts, resolver semantics, or reliability aggregation was changed.

No Phase15C lifecycle behavior, automatic session inference, generic memory, cloud synchronization, or cross-agent handoff was added.
