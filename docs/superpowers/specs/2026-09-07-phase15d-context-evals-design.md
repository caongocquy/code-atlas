# Phase 15D — Context Intelligence Evals

**Status:** Proposed design specification

## 1. Goal

Provide objective evidence that Context Intelligence reduces coding-agent context cost without reducing correctness or repository understanding.

## 2. Eval dimensions

### Relevance / breadth

Measure whether `context(task)` selects the right working set.

Metrics:

- required-file recall@K
- required-symbol recall@K
- MRR
- irrelevant-context ratio
- packed tokens

### Repetition / delivery

Measure Context-Aware Reads.

Metrics:

- full-equivalent tokens requested
- actual tokens delivered
- saved tokens and percentage
- unchanged hit count
- delta hit count
- rehydrate count/rate
- delta efficiency

### Agent-level outcome

Where reproducible harness automation is available:

- search/read tool calls
- total injected context tokens
- number of unrelated files read
- wrong-file edits
- task completion/pass rate
- time/tool steps to first correct edit

Correctness metrics dominate token-saving metrics.

## 3. Fixture design

Include multi-step tasks that force repeated reads and changing source:

- bug fix with one symbol edit/read/re-read
- change spanning caller/callee
- affected test update
- symbol move/rename conservative rehydrate
- source edit between reads
- context reset/compaction
- two worktrees with identical starting content
- incomplete graph evidence
- optional semantic provider absent/present

## 4. Baselines

Compare at least:

1. `rg`/plain lexical exploration.
2. Existing CodeAtlas primitives without Context Intelligence.
3. Task Context only.
4. Context-Aware Reads only.
5. Combined Task Context + Context-Aware Reads.

Optional semantic/vector baseline may be included when configured.

## 5. Safety gates

No release if any of these occur:

- stale-context correctness bug
- cross-worktree receipt collision
- materially worse required-file/symbol recall
- missing uncertainty diagnostics where previous CodeAtlas behavior exposed incompleteness
- legacy client compatibility regression

## 6. Release evidence

The public Context Intelligence release should include a reproducible summary such as:

```text
Relevant context recall@10:  X%
Repeated context saved:      Y%
Exploration tool calls:      -Z%
Task success:                unchanged or improved
Stale-context failures:      0
```

Do not publish cherry-picked metrics without the fixture/baseline definition.

## 7. Acceptance criteria

1. Combined system beats existing CodeAtlas primitive-only baseline on total context cost.
2. Required context recall remains above the agreed quality threshold.
3. Repeated delivery savings are significant on multi-step tasks.
4. Zero known stale-context correctness failures.
5. Results are deterministic enough for regression gating where applicable.

