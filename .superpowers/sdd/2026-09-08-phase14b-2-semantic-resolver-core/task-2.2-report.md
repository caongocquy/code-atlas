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

## Loop round 1: reviewer ruling

### Findings

- Budget construction and consumption accepted `NaN`, negative, non-finite, fractional, and unsafe-integer operation counts.
- Memo entries retained caller-owned mutable arrays and objects and returned mutable internal references.

### TDD evidence

- Red: added regression tests failed on `NaN` initial budgets and caller mutation changing the stored memo value.
- Green: focused work-control tests pass with `4/4` tests and `0` failures.

### Fix

- `createBudgetLedger` now rejects every invalid operation count with `RangeError`; zero and safe-integer boundaries remain valid.
- `createResolverMemo` clones entries on write with `structuredClone` and deep-freezes stored snapshots, isolating both caller-owned inputs and returned values.

### Loop validation

- `node --import tsx/esm --test test/phase14b-resolver-work-controls.test.ts` passed (`4/4`).
- `./node_modules/.bin/tsc --noEmit` passed.
- `git diff --check` passed.
