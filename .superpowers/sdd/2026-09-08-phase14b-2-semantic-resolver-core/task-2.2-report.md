# Task 2.2 Report: Deterministic Resolver Work Controls

## Scope

Implemented Phase 14B Track 14B-2 Task 2.2 only:

- Added deterministic operation budgets in `src/core/graph/resolver/budgets.ts`.
- Added stable-only resolver memo contracts in `src/core/graph/resolver/memo.ts`.
- Added the focused contract test in `test/phase14b-resolver-work-controls.test.ts`.

No resolver, `TypeEnvironment`, persistence, package, wall-clock, or timeout behavior was changed.

## TDD evidence

- Red: `node --import tsx/esm --test test/phase14b-resolver-work-controls.test.ts` failed because the new modules did not exist.
- Green: the same focused test passed with `1/1` tests and `0` failures.

## Validation

- `./node_modules/.bin/tsc --noEmit` passed.
- `git diff --check` passed.
- `pnpm exec tsc --noEmit` was not usable in this non-TTY worktree because pnpm attempted to purge/install `node_modules` and exited with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`; no install or package change was performed.

## GitNexus

Impact analysis was run for the existing imported contract symbols (`TypeRef`, `EvidenceId`, `UnknownReason`, and `SymbolIdentity`) with `--repo code-atlas --direction upstream`. The indexed repository reported each target as not found because its index predates these Phase 14B symbols, so the result was `UNKNOWN`; current source contracts were inspected directly. `detect_changes` is run before commit as required.
