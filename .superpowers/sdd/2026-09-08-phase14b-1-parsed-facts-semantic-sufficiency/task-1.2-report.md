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
