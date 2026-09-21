# Task 1.2 Report — Language-owned fact extraction and parser dispatch

## Status

Implemented on the task branch; ready to commit after final verification.

## Scope completed

- Added `LanguageFactExtractorInput` and `LanguageFactExtractor` contracts.
- Added a language-owned extractor registry with `getLanguageFactExtractor`.
- Routed `extractParsedFacts` through exactly one registered extractor.
- Kept parser selection in the shared `parseSource` entry point and passed the
  real `filePath` from the indexing pipeline.
- Added the first non-ECMAScript parser adapter for Python, including the
  objective function/class symbol smoke extraction and parser identity:
  `tree-sitter-python` / `tree-sitter`.
- Preserved the existing objective fact extraction shape and parser diagnostics.
- Kept facts and facts-schema versions unchanged; no semantic resolver or
  resolution target/confidence fields were added.

## TDD evidence

1. Added `test/phase14b-fact-extractor-dispatch.test.ts` before implementation.
2. Ran the required RED command:
   `node --import tsx/esm --test test/phase14b-fact-extractor-dispatch.test.ts`.
   Result: failed as expected because Python had no registered parser/extractor.
3. Added the language extractor registry, Python parser adapter, and dispatch.
4. Ran the required focused command:
   `node --import tsx/esm --test test/phase14b-fact-extractor-dispatch.test.ts test/phase14a-facts.test.ts`.
   Result: 11 passed, 0 failed.

## Validation

- `node --import tsx/esm --test test/phase14a-*.test.ts test/phase14b-facts-contract.test.ts test/phase14b-fact-extractor-dispatch.test.ts` — 74 passed, 0 failed.
- `node_modules/.bin/tsc --noEmit` — passed.
- `node_modules/.bin/eslint` on all task-owned and compatibility files — passed.
- `git diff --check` — passed.
- GitNexus `detect_changes --repo code-atlas` — low risk, 7 files, 2 indexed symbols, 0 affected processes.

## Impact and concerns

- GitNexus impact queries for `extractParsedFacts` and `parseSource` returned
  `UNKNOWN` because the available index does not contain the current task
  branch symbols. CodeGraph reported the target worktree was not locally
  indexed; no index was created or modified.
- Adding `tree-sitter-python` required `package.json`, `pnpm-lock.yaml`, and
  `pnpm-workspace.yaml` compatibility changes. The workspace allow-build entry
  is enabled so the native grammar package can build deterministically.
- `pnpm exec tsc` and `pnpm exec eslint` attempted a non-TTY module reinstall
  after the dependency addition and aborted with
  `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`; the equivalent local binaries
  passed without reinstalling dependencies.
- JavaScript/TypeScript behavior remains covered by the Phase 14A regression
  suite. Other language IDs remain unregistered and correctly return an
  infrastructure failure until their parser packages and language-owned
  extractors are added in later tasks.

## Files changed

- `.superpowers/sdd/2026-09-08-phase14b-1-parsed-facts-semantic-sufficiency/task-1.2-report.md`
- `package.json`
- `pnpm-lock.yaml`
- `pnpm-workspace.yaml`
- `src/core/facts/language-fact-extractor.ts`
- `src/core/facts/facts-extractor.ts`
- `src/core/graph/parsers/adapters/python.ts`
- `src/core/graph/parsers/code-parser.ts`
- `src/core/graph/parsers/registry.ts`
- `src/core/indexing/index-pipeline.service.ts`
- `test/phase14b-fact-extractor-dispatch.test.ts`

## Loop round 1 ledger fix

Applied the ledger ruling from review:

- Removed the `tree-sitter-python` dependency and its lockfile/workspace
  build-policy entries.
- Removed the Python parser adapter and parser-registry registration.
- Kept only the currently registered TypeScript, TSX, and JavaScript fact
  extractors. Python and the other declared language IDs now return
  `infrastructure_failure` until their owning grammar-integration task.
- Kept the language extractor contract/registry, fact-extractor dispatch, real
  pipeline file paths, and dispatch regression test.
- Made `parseSource` accept an optional expected language and reject a file
  path whose registered adapter language differs before parsing semantic facts.
- Added regression tests for TypeScript success/parser identity, unregistered
  Python failure, file-path/language mismatch, and exactly-one extractor
  dispatch.

## Loop round 1 TDD and validation

1. Updated the dispatch test first and ran the focused test. It failed because
   Python was still registered and returned facts.
2. Removed the grammar/package/registry integration and ran the focused test:
   4 passed, 0 failed.
3. Ran `node_modules/.bin/tsc --noEmit`: passed.
4. Ran the focused Phase 14A/14B fact suite: 37 passed, 0 failed.
5. Ran the full suite with
   `node --import tsx/esm --test test/*.test.ts`: 323 passed, 0 failed.
6. Ran `git diff --check`: passed.

No facts version, facts schema version, semantic resolver, or grammar package
integration was added in this fix.
