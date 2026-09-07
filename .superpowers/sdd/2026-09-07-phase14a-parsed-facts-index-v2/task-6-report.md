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
- Added position-preserving source masking for comments, quoted strings, and template literals before facts-path evidence regexes run; newlines remain intact for evidence lines and ranges.
- Extended the mask with a deterministic regex-literal heuristic and recursive template interpolation scanning: template text is hidden while `${...}` executable code remains visible and gets the same comment/string/regex masking. Control-flow delimiter state recognizes regex literals after `if`, `while`, `for`, `switch`, and `catch` parentheses; character classes and escaped slashes are handled without consuming following source. Nested interpolation returns to the correct template frame.
- Made fact chunk materialization honor start/end columns for same-line symbols.
- Added regressions for control-flow regexes, regex character classes, escaped slashes, nested template interpolation, false extends/member evidence, and preserved executable interpolation member evidence.

GitNexus impact analysis and CodeGraph inspection were attempted for the task symbols. Both reported that this worktree is not indexed; no index was initialized, and direct source inspection was used as required.

## Validation

- `node --import tsx/esm --test test/phase14a-single-parse.test.ts test/phase14a-equivalence.test.ts` — 12 passed.
- `node --import tsx/esm --test test/phase14a-cache.test.ts test/phase14a-equivalence.test.ts test/phase14a-facts.test.ts test/phase14a-generation.test.ts test/phase14a-invalidation.test.ts test/phase14a-single-parse.test.ts test/graph.test.ts test/phase3-lexical.test.ts test/phase5-provider-boundaries.test.ts test/phase13-remediation.test.ts` — 66 passed.
- `npx tsc --noEmit` — passed.
- `git diff --check` — passed.

## Boundary

The facts path uses small source-evidence adapters in `member-resolution.ts` and `extends.ts`; the legacy path still uses its existing Tree-sitter parsing. `source-mask.ts` is a position-preserving lexical helper only for those facts evidence adapters: it blanks comments, quoted strings, regex literals, and template text while retaining newlines and recursively exposing interpolation code. It does not parse or construct a Tree-sitter tree. `src/core/change/transient-graph.ts` remains unchanged and independent.
