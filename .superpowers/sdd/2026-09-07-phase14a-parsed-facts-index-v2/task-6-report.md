# Phase 14A Task 6 report

## Scope

Implemented only the single-parse facts seam for graph, lexical, and semantic consumers. Task 7+ pipeline orchestration, Task 8 race handling, and Phase 13 transient-graph code were not changed.

## Changes

- Added `IndexedSourceUnit` and source-text-to-`CodeChunk` materialization.
- Added `buildCodeGraphWithResolutionFromFacts` and `buildFileGraphsFromFacts`.
- Graph fact builds use parsed symbol/import/call facts and fact parse diagnostics; legacy builders remain compatible.
- Added `toLexicalDocumentsFromFacts` and optional fact-unit inputs for lexical/semantic indexing.
- Added graph-service fact-unit plumbing without changing pipeline orchestration.
- Added cold/unchanged/modified fact-miss parser-counter coverage and clean graph equivalence coverage.

GitNexus impact analysis and CodeGraph inspection were attempted for the task symbols. Both reported that this worktree is not indexed; no index was initialized, and direct source inspection was used as required.

## Validation

- `node --import tsx/esm --test test/phase14a-single-parse.test.ts test/phase14a-equivalence.test.ts` — 3 passed.
- `node --import tsx/esm --test test/graph.test.ts test/phase3-lexical.test.ts` — 9 passed.
- `npx tsc --noEmit` — passed.
- `git diff --check` — passed.

## Concern

The existing member/extends resolver implementations are outside the Task 6 allowed file list and still parse source when a facts build contains member calls or `extends`; the new facts seam skips those parsers when the corresponding structure is absent. Full resolver conversion would require the parser-helper files reserved by the earlier canonical-extraction task and is intentionally not started here.
