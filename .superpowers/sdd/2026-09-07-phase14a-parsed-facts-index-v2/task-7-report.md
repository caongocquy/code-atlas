# Phase 14A Task 7 report

## Outcome

Implemented the unified init/index/sync candidate-generation lifecycle in the
`code-atlas-phase14a` worktree. The pipeline now captures all current source
hashes, plans invalidation, reuses content-addressed parsed facts, parses only
cache misses, builds graph and lexical state from shared fact units, validates a
candidate, and publishes one active generation. Deleted paths are absent from
the next manifest and graph.

Added the typed `PublishedIndexRun`, `FailedIndexRun`, and `IndexRunOutcome`
contracts. Existing CLI-facing result fields remain available as a compatibility
view because the CLI adapters are intentionally outside Task 7 scope.

## Impact analysis

GitNexus impact analysis could not run: the worktree has no GitNexus index, and
the MCP impact tool reported `index_required` while its only suggested action
would initialize/mutate the repository index. CodeGraph also reported that this
worktree is not indexed. No index was initialized; callers were inspected
directly in the pipeline, CLI, MCP, graph, lexical, semantic, and AtlasStore
sources.

## Validation

- `node --import tsx/esm --test test/phase14a-indexing.test.ts test/phase4-index-pipeline.test.ts` — pass, 6/6.
- `node --import tsx/esm --test test/phase10-mcp.test.ts test/phase11-integration.test.ts` — pass, 15/15.
- `npx tsc --noEmit` — pass.
- `git diff --check` — pass.

Task 8 race handling and Tasks 9–11 were not started.

## Concerns

- Optional semantic providers remain compatible when disabled/unavailable; this
  Task 7 integration does not introduce a new mandatory semantic dependency.
- CLI/MCP adapter files were not changed per the requested Task 7 file scope;
  their existing compatibility surface is preserved by the pipeline result
  view.
