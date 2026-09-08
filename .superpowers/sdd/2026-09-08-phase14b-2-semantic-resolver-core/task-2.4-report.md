# Task 2.4 report

Implemented the deterministic semantic resolver core for Track 14B-2.

- Added the terminal `ResolutionDecision` union and unique-target candidate gate.
- Weak-only candidates remain `unknown`; ambiguity and deterministic budget exhaustion remain explicit terminal outcomes.
- Added the fixed `ORDERED_STRATEGIES` dispatch and canonical candidate ordering.
- Added generation-scoped resolver context with an in-memory trace collector.
- Added TDD coverage for decision gating, strategy order, budget exhaustion, and cold/warm memo semantic equivalence.

Validation:

- `node --import tsx/esm --test test/phase14b-resolver-contract.test.ts test/phase14b-type-environment.test.ts test/phase14b-resolver-work-controls.test.ts test/phase14b-resolver-decisions.test.ts test/phase14b-resolver-determinism.test.ts` — 19/19 passed.
- `./node_modules/.bin/tsc --noEmit` — passed.
- `git diff --check` — passed.

## Loop round 2

Addressed the two remaining review findings:

- The `return` strategy now identifies the requested callable from site-linked facts/evidence and resolves it through the injected `TypeEnvironment.resolveReturn(callable)` API, retaining source/repository scoping and supporting evidence IDs.
- The determinism fixture now uses a positive candidate budget and a real lexical resolution path. Cold resolution creates a stable memo entry; warm resolution reads it with equivalent output and avoids a second environment lookup.

Loop 2 validation:

- `node --import tsx/esm --test test/phase14b-resolver-contract.test.ts test/phase14b-type-environment.test.ts test/phase14b-resolver-work-controls.test.ts test/phase14b-resolver-decisions.test.ts test/phase14b-resolver-determinism.test.ts` — 25/25 passed.
- `./node_modules/.bin/tsc --noEmit` — passed.
- `git diff --check` — passed.
- `pnpm exec tsc --noEmit` was not usable in this managed non-TTY worktree because pnpm attempted an install and aborted with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`; the local compiler command above completed successfully.

Scope exclusions honored: no graph integration, persistence, concrete language adapters, or package changes.

## Loop round 1

Applied the ledger ruling and reviewer findings:

- Candidate and supporting evidence collection now requires the requested site and matching source unit; resolved targets and provenance are repository-scoped.
- Strategies dispatch through the injected `TypeEnvironment`; generation-scoped `context.memo` stores and serves deterministic symbol results for warm resolution.
- Duplicate targets merge all supporting evidence IDs with canonical sorting.
- The budget ledger records failed operations; `budget_exhausted` is emitted only after an actual failed consume.
- Registered adapters are checked through `capabilities(language)` per strategy, producing explicit `unsupported` outcomes when required capabilities are unavailable.

Loop 1 validation:

- `node --import tsx/esm --test test/phase14b-resolver-contract.test.ts test/phase14b-type-environment.test.ts test/phase14b-resolver-work-controls.test.ts test/phase14b-resolver-decisions.test.ts test/phase14b-resolver-determinism.test.ts` — 24/24 passed.
- `./node_modules/.bin/tsc --noEmit` — passed.
- `git diff --check` — passed.
