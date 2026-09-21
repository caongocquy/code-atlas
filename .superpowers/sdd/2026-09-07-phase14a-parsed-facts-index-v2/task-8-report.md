# Phase 14A Task 8 Report

## Scope

Executed Task 8 only: race-safe source capture and atomic publication guards. Task 9+ were not started.

GitNexus/CodeGraph impact analysis was attempted for `extractParsedFacts`, `runPipeline`, candidate-generation methods, and `detectFilesystemChanges`, but the available CodeAtlas tool returned `index_required`; no index was initialized. The remaining analysis used direct source inspection.

## Changes

- Added the required `SourceRead`, `SourceReader`, and `StableFactExtraction` contracts.
- Added `extractStableFacts`, which performs `before -> extract -> after`, retries once after a hash mismatch, and throws `SourceRaceError` after the second mismatch.
- Routed cache-miss fact extraction through the stable capture seam and preserved the stable source/hash in candidate bindings.
- Routed cache-hit source-dependent processing through the same before/cached-facts/after stability boundary without invoking Tree-sitter; a changed hash falls back to stable extraction and refreshes the fact blob.
- Capped `maxAttempts` to two, preserving the default and preventing a caller from enabling a third attempt.
- Preserved Task 7 typed outcomes by mapping `SourceRaceError` to `source_race`; other errors remain `infrastructure_failure`.
- Confirmed `AtlasStore.publishCandidateGeneration` already performs candidate validation, capability-state updates, generation commit, and active-pointer update in one transaction with rollback. No AtlasStore change was required.

## Validation

- `node --import tsx/esm --test test/phase14a-races.test.ts test/phase14a-generation.test.ts test/phase14a-indexing.test.ts test/phase4-index-pipeline.test.ts test/phase13-remediation.test.ts` — 34/34 passed.
- `npx tsc --noEmit` — passed.
- `git diff --check` — passed.

## Review fixes

- Added deterministic coverage for cache-hit stability and parser reuse.
- Added deterministic coverage proving `maxAttempts: 3` still performs only two attempts and returns `source_race`.

## Concerns

- The pipeline's deterministic injected-reader seam is covered directly by `extractStableFacts` tests; the production pipeline uses the filesystem reader and existing store transaction seam.
- No changes were made to `src/storage/atlas/atlas.store.ts` because its existing publication transaction already satisfies the Task 8 atomic pointer and rollback invariant.
