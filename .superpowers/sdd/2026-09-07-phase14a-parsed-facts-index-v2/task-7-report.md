# Phase 14A Task 7 report

## Outcome

Implemented the unified init/index/sync candidate-generation lifecycle in the
`code-atlas-phase14a` worktree. The pipeline now captures all current source
hashes, plans invalidation, reuses content-addressed parsed facts, parses only
cache misses, builds graph and lexical state from shared fact units, validates a
candidate, and publishes one active generation. Deleted paths are absent from
the next manifest and graph.

Added the typed `PublishedIndexRun`, `FailedIndexRun`, and `IndexRunOutcome`
contracts. `indexRepository` and `syncRepository` now return the union at their
public boundary; adapters narrow failed outcomes before formatting the existing
success/error surfaces.

The review fixes also wire optional semantic indexing into the shared fact-unit
lifecycle. Enabled and available providers embed candidate facts and stage
semantic rows; disabled, unconfigured, and unavailable providers remain
compatible and non-mandatory. Graph, lexical, semantic, file-capability, and
version metadata writes are staged before one transactional active-generation
pointer switch. Empty repositories publish valid zero-symbol generations.

The remaining Task 7 review fixes now upsert embedded candidate points through
the configured `VectorStore` API, while retaining generation-scoped SQLite
staging. A provider preparation failure or unavailable provider fails the run
when semantic capability is already active, retaining the previous generation;
disabled semantic runs copy the active semantic rows into the new candidate so
they do not hide existing semantic data.

## Impact analysis

GitNexus impact analysis could not run: the worktree has no GitNexus index, and
the MCP impact tool reported `index_required` while its only suggested action
would initialize/mutate the repository index. CodeGraph also reported that this
worktree is not indexed. No index was initialized; callers were inspected
directly in the pipeline, CLI, MCP, graph, lexical, semantic, and AtlasStore
sources.

## Validation

- `node --import tsx/esm --test test/phase14a-indexing.test.ts test/phase4-index-pipeline.test.ts` — pass, 13/13.
- `node --import tsx/esm --test test/phase10-mcp.test.ts test/phase11-integration.test.ts` — pass, 16/16.
- `node --import tsx/esm --test test/phase5-provider-boundaries.test.ts` — pass, 6/6.
- `node --import tsx/esm --test test/graph.test.ts test/phase3-lexical.test.ts test/phase12-cli-regression.test.ts test/phase13-remediation.test.ts` — pass, 36/36.
- `npx tsc --noEmit` — pass.
- `git diff --check` — pass.

Task 8 race handling and Tasks 9–11 were not started.

## Concerns

- GitNexus impact analysis could not run without initializing a missing index;
  direct caller inspection was used instead, as documented above.
- The semantic path stages generation vectors in AtlasStore; external provider
  resources remain optional and are closed by the existing adapters.
- Minimal CLI and MCP adapters narrow failed outcomes before formatting; progress
  UX remains unchanged.
- The configured external vector store receives candidate upserts. External
  stale-point cleanup is intentionally not performed by this generation
  boundary because the `VectorStore` contract has no atomic active-generation
  transaction; the existing standalone semantic path retains its copy-on-write
  cleanup behavior.
