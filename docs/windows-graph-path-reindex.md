# Windows graph-path parity — existing index recovery

Applies to PR #39 and later releases containing the Windows graph-path normalization fix.

## Why reindex?

Previously, a Windows index could persist repository-relative graph paths using `\\` separators (for example `src\\feature\\entry.ts`). Graph import resolution and node IDs now use portable POSIX-style paths (`src/feature/entry.ts`) on all hosts.

**No automatic legacy graph-identity migration is included.** Do not rely on incremental `sync` to convert old persisted graph identities.

## Safe upgrade procedure (Windows)

1. Finish active Code Atlas CLI/MCP/UI processes for the repository so no writer is using the database.
2. Back up the entire `.codeatlas/` directory **outside the repository**, including `.codeatlas/atlas.db` and any companion files. Keep that backup until verification finishes.
3. Use a Code Atlas build containing the PR #39 path fix (after it is approved and shipped). From the repository root, run:

   ```powershell
   code-atlas reindex . --json
   code-atlas status . --json
   ```

4. Confirm the command exits successfully, reports a full graph rebuild, and status reports a usable graph/index. If either command fails, do not perform incremental sync or delete the backup; diagnose the failure first.
5. Validate the repository-specific graph queries and imports/calls used by your workflow. Graph paths and graph node identities should be normalized to forward slashes. In particular, verify renamed/deleted files do not leave stale entries.
6. Once verified, continue normal `code-atlas sync .` usage. The original backup may be retained for rollback.

If recovery is needed, stop Code Atlas processes and restore **the entire backed-up state** before restarting. Do not copy only the SQLite main database while leaving associated files from a different generation.

## Engineering qualification

The PR #39 focused suite checks Windows-style incremental file inputs, cross-platform import/call parity, and deletion cleanup, with 4/4 OS/Node jobs passing at `940a480`. The current-master full-suite differential run [#43566425230](https://github.com/caongocquy/code-atlas/actions/runs/43566425230) reported no added/changed failures or new skips, **but it was not an upgrade simulation using a persisted pre-fix Windows database**.

Before claiming automatic or proven migration safety, construct a true legacy-index fixture, force a reindex, reopen the persisted store, and verify stale backslash-path nodes/edges are absent. Until that is demonstrated, this document is an operator recovery procedure rather than a passed migration test.

This work is independent of CA-01's frozen release-target qualification. Do not rebaseline, waive, or change that release gate.
