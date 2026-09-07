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
- Deduplicated facts-path import edges by module specifier, matching legacy `extractImports` behavior.
- Added facts-path source-evidence adapters for member and extends resolution; these paths do not instantiate Tree-sitter. Legacy resolver calls remain unchanged.
- Made fact chunk materialization honor start/end columns for same-line symbols.

GitNexus impact analysis and CodeGraph inspection were attempted for the task symbols. Both reported that this worktree is not indexed; no index was initialized, and direct source inspection was used as required.

## Validation

- `node --import tsx/esm --test test/phase14a-single-parse.test.ts test/phase14a-equivalence.test.ts` — 6 passed.
- `node --import tsx/esm --test test/graph.test.ts test/phase3-lexical.test.ts test/phase5-provider-boundaries.test.ts test/phase6-local-vector.test.ts test/phase13-remediation.test.ts` — 32 passed.
- `npx tsc --noEmit` — passed.
- `git diff --check` — passed.

## Boundary

The facts path uses small source-evidence adapters in `member-resolution.ts` and `extends.ts`; the legacy path still uses its existing Tree-sitter parsing. `src/core/change/transient-graph.ts` remains unchanged and independent.
