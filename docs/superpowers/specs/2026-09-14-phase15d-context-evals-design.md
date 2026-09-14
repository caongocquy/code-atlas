# CodeAtlas Phase15D — Context Evaluation & Regression Gates

**Status:** Approved design specification
**Scope:** Internal deterministic evaluation and release gates for Phase15A/B/C

## 1. Purpose

Phase15D evaluates whether CodeAtlas context intelligence:

- selects the correct file and symbol context;
- avoids unnecessary context;
- preserves required-authority semantics;
- preserves uncertainty when graph or index evidence is stale or incomplete;
- reduces repeated context delivery through Phase15A and Phase15C;
- reconstructs exact content;
- behaves deterministically; and
- preserves lifecycle and workspace isolation.

Phase15D is an internal release-gate system. It is not a public CodeAtlas
feature and must not weaken or special-case production Phase15A/B/C behavior.

Phase15D v1 does not add a public `code-atlas eval` command, MCP evaluation
tools, an LLM judge, API or network dependencies, remote corpus fetching, or a
generic AI benchmark framework.

## 2. Product decisions

Phase15D v1 is:

- an internal release gate;
- deterministic and offline;
- a hybrid corpus of synthetic cases and frozen real-repository snapshots;
- based on a versioned golden quality baseline;
- composed of correctness hard gates and quality regression budgets;
- latency/performance-observing but not latency-blocking;
- invoked by `npm run eval:context`;
- driven by declarative JSON cases; and
- implemented under `eval/context/` as a context-specific harness.

There is no generic framework for graph, search, or impact evaluation in v1.
Production code does not gain an eval-only execution path.

## 3. Evaluation architecture

```text
Eval Case
  -> Corpus Loader
  -> Isolated Workspace Materializer
  -> Production Phase15A/B/C APIs
  -> Observed Result
  -> Deterministic Normalizer
  -> Correctness / Quality / Lifecycle Scorers
  -> Golden Baseline Comparator
  -> Gate Evaluator
  -> Human Report + Machine Report
  -> PASS / FAIL exit code
```

The harness is expected to be organized as:

```text
eval/context/
├── corpus/
│   ├── manifest.json
│   ├── synthetic/
│   └── snapshots/
├── baselines/
│   └── context-eval-v1.json
├── runner/
│   ├── load-corpus.ts
│   ├── materialize-workspace.ts
│   ├── execute-case.ts
│   ├── normalize-result.ts
│   ├── score-case.ts
│   ├── aggregate.ts
│   └── report.ts
└── run.ts
```

Names are organizational boundaries, not a requirement to create empty or
speculative modules. The implementation may combine files while preserving
these responsibilities.

## 4. Corpus contract

The corpus is declarative JSON. Its manifest version is `context-eval-v1`.
Cases have a stable case ID, case kind, language, workspace or snapshot
reference, task, anchors, optional lifecycle/mutation scenario, correctness
truth, and quality budgets.

Correctness truth contains:

- `requiredSubjects`;
- `supportingSubjects`; and
- `forbiddenRequiredSubjects`.

Truth is manually reviewed correctness evidence. The evaluator must never
automatically regenerate, amend, or bless truth.

Truth and the golden baseline are separate: truth says what must be correct;
the baseline records the reviewed quality level against which regressions are
measured.

## 5. Synthetic corpus

Synthetic coverage must include every language exposed by the production
supported-language registry. The evaluator must obtain this set from the
production registry (currently `LANGUAGE_CONFIGS` in
`src/core/graph/parsers/languages.ts`), or from a production API that directly
exposes that registry. It must not maintain a second hard-coded language list.

The runner fails corpus validation if any currently supported language has no
case in each required class below. Therefore the minimum matrix size is
derived as `3 × supportedLanguageCount`, rather than fixed to a stale number.

Each supported language has at least these conceptual case classes:

1. **exact-target:** an exact file or symbol task whose required target is
   retained;
2. **relationship/change:** a caller, import, implementation, or change
   relation where required and supporting context are found appropriately; and
3. **incomplete/ambiguity:** ambiguous symbols or incomplete graph evidence
   where uncertainty is preserved and no false required promotion occurs.

Focused cross-language regressions are added only where useful for nested or
member symbols, same-line symbols, imports/re-exports,
inheritance/implementation, template/interpolation-like syntax, ambiguous
same-name symbols, or malformed/partial source. Edge cases are not multiplied
mechanically across every language.

## 6. Frozen real-repository snapshots

Use approximately four to five small, purpose-built ecosystems, preferably:

- TypeScript/JavaScript;
- Python;
- Go;
- Java or Kotlin; and
- Rust.

Snapshots run entirely offline, contain only source required for their cases,
exclude vendor/build artifacts and unnecessary large files, and are immutable
evaluation evidence. Runtime evaluation never fetches an upstream repository.

Every snapshot has provenance metadata containing:

- `snapshotId`;
- source repository;
- source commit SHA;
- license identifier or expression;
- included paths;
- language; and
- reason for inclusion.

License metadata is not a substitute for required license notices. If the
source license requires inclusion of license text or notices for the selected
files, the snapshot stores the applicable notice alongside its provenance.
Otherwise metadata-only attribution is sufficient. Reproducing or downloading
upstream snapshots is a separate corpus-maintenance workflow, not runtime eval.

Snapshot cases collectively cover representative agent tasks: bug fix or
behavior change, rename or API change, cross-module impact, test adjustment,
and a small multi-caller refactor. Every snapshot need not cover every task.
Lifecycle cases are concentrated mainly in one representative TypeScript
snapshot, with limited synthetic coverage.

## 7. Workspace isolation and offline execution

Every case materializes a fresh ephemeral workspace from clean source state,
without inherited `.codeatlas` state. Each case receives its own index and
context database and shares no state with another case. A lifecycle scenario
may preserve state within that scenario to test restart continuity, but never
reuses another case's state.

`npm run eval:context` requires:

- no network;
- no API keys;
- no LLM;
- no Docker; and
- no GPU.

The runtime evaluator must not clone, fetch, call an API, call an LLM, or
download corpus data. Any unavailable or prohibited dependency is a failed
offline contract, not an opportunity to fall back to a remote service.

## 8. Determinism and normalization

Selected cases execute independently from clean state at least twice. The
runner compares semantic normalized output. Host noise may be normalized,
including temporary absolute workspace roots, ephemeral process IDs,
host-specific temporary paths, and timestamps that are not semantic.

Normalization must retain repository-relative paths, symbol identities,
selected subjects and their ordering, reliability/completeness, required
status, task identity semantics, and plan selection semantics. Semantic
equality includes the normalized selected-subject sequence, plan identity and
selection decisions, required/supporting/forbidden classification, uncertainty
and completeness evidence, delivery mode and item ordering, reconstructed
authoritative content, and declared lifecycle mode sequence. It excludes only
the explicitly listed host noise.

Fresh determinism means that the same case in independent clean workspaces has
the same semantic result. Lifecycle continuity determinism means that the same
persisted lifecycle state after restart produces the same expected next
behavior. A case seed may be reserved for future fixture generation, but v1
introduces no unnecessary randomness.

## 9. Correctness gates

Correctness is evaluated per case with zero tolerance. The release fails if
any correctness gate fails:

- required hit rate is 100%;
- false required count is 0;
- plan selection is deterministic;
- subject selection is deterministic;
- reconstructed content is correct;
- uncertainty is preserved; and
- workspace isolation is correct.

The evaluator also preserves these Phase15A/B/C invariants:

- unchanged deliveries do not resend bodies;
- full, delta, and rehydrate delivery reconstruct authoritative current content
  exactly;
- restart continuity remains correct;
- immutable task intent remains immutable;
- cross-worktree lifecycle handles do not resume;
- a losing CAS refresh writes no stray receipts or snapshots; and
- incomplete graph evidence never becomes false certainty.

Correctness cannot be made to pass by accepting a new quality baseline.

## 10. Quality metrics and policy ownership

Track at least:

- `selectedItems`;
- `estimatedTokens`;
- `returnedBytes`;
- `supportingHitRate`;
- `contextPrecision`; and
- required and supporting target rank/position where meaningful.

`contextPrecision` is deterministic and uses selected subjects relative to the
reviewed required/supporting truth set. It is not an LLM usefulness score.

Quality policy is owned by the versioned baseline/policy data under
`eval/context/baselines/`; scorer code contains no scattered policy constants.
The policy is reviewed as repository data and applies only to the corpus and
baseline version named by the report.

The initial policy is:

Corpus aggregate:

- estimated tokens: no more than 10% above baseline;
- returned bytes: no more than 10% above baseline;
- selected items: no more than 10% above baseline;
- required hit rate: never lower; and
- supporting hit rate: no more than five percentage points lower.

Per-case catastrophic ceilings:

- tokens: no more than 2× baseline;
- bytes: no more than 2× baseline;
- selected items: no more than baseline plus `max(3, 100%)`; and
- required targets: never absent from the selected set.

These values change only through an explicit reviewed baseline or policy
change.

## 11. Golden baseline and version behavior

The versioned golden baseline is separate from correctness truth and contains,
at minimum, per case:

```text
caseId
baseline:
  selectedItems
  estimatedTokens
  returnedBytes
  requiredHitRate
  supportingHitRate
regressionBudget:
  maxTokenIncreasePct
  maxReturnedBytesIncreasePct
  maxSelectedItemsIncreasePct
  maxSupportingHitRateDecreasePp
catastrophicCeiling:
  maxEstimatedTokens
  maxReturnedBytes
  maxSelectedItems
```

The baseline and corpus must declare compatible versions. A missing baseline
case, an orphan baseline case, duplicate case ID, duplicate baseline ID, or
version mismatch fails evaluation with an actionable report. No missing case
is silently treated as a new baseline, and no orphan is silently deleted.

The normal evaluator (`npm run eval:context`) never writes the baseline.

A separate developer-only workflow,
`npm run eval:context:update-baseline`, runs the current corpus, displays
old-to-new metric differences, and writes only with an explicit `--write`
opt-in. It must not modify correctness truth. A correctness failure blocks
baseline acceptance even when the proposed quality metrics look better.

## 12. Lifecycle evaluation

Lifecycle evaluation records:

- `fullItems`;
- `deltaItems`;
- `unchangedItems`;
- `rehydratedItems`;
- `requestedBytes`;
- `returnedBytes`;
- `savedBytes`;
- `reuseRate`; and
- `bodyResendCount`.

Lifecycle truth may declare expected mode sequences for bounded scenario
primitives understood by the common runner, for example:

```text
start -> unchanged refresh -> source mutation -> refresh -> restart -> refresh
```

Correctness remains hard-gated; savings and reuse are quality metrics. There
is no bespoke executable test script per JSON case.

## 13. Performance observations

Reports may include index/load, compile, lifecycle-start, and refresh duration,
plus cheap process-memory observations when stable enough. Performance is
non-blocking in v1: no release thresholds are defined for latency or memory
because machine and CI variance would make those gates flaky. Meaningful
deltas remain visible in reports.

## 14. Reports and exit behavior

The human report summarizes PASS/FAIL, corpus coverage, correctness, quality
regression, largest token/byte changes, lifecycle reuse/savings, performance
observations, and failed cases with reasons.

The machine report at the transient path `artifacts/context-eval-report.json`
contains:

- `schemaVersion`;
- `corpusVersion`;
- per-case observed metrics;
- aggregate metrics;
- gate decisions; and
- timing observations.

The report is an execution artifact, not the golden baseline. PASS and FAIL
exit codes are deterministic. The report path is disposable and must not be
committed as evaluation truth.

## 15. Explicit exclusions

Phase15D v1 excludes:

- remote benchmarks;
- automatic GitHub cloning;
- a cloud evaluation service;
- a generic graph/search/impact evaluation framework;
- a framework-specific React Native/Flutter benchmark suite;
- benchmark-driven production shortcuts; and
- production logic that exists only for the evaluator.

It also excludes Phase15E work, public API surfaces, LLM judging, network
fetching, and changes to Phase15A/B/C storage or delivery semantics.

## 16. Definition of done

Phase15D is complete only when:

- `npm run eval:context` works from a clean checkout;
- the full evaluator runs offline;
- synthetic correctness coverage is validated against every supported
  production language;
- frozen snapshots have complete provenance and applicable license notices;
- correctness gates pass deterministically;
- truth cannot be auto-updated;
- the golden baseline is versioned and explicitly updated only;
- aggregate quality and per-case catastrophic gates are exercised;
- lifecycle reuse and reconstruction metrics are exercised;
- clean repeated executions have identical semantic outcomes;
- human and machine reports are stable and readable;
- PASS/FAIL exit codes are deterministic;
- performance is reported but non-blocking;
- Phase15A/B/C production behavior is not weakened or special-cased; and
- no public API surface is added.
