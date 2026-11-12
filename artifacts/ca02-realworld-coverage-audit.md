# CA-02 real-world graph coverage — stage audit

## Verified measurements

Source: `sindresorhus/p-queue` at immutable SHA `7f272ab5ff2254c0dc2537b7977e88ede1cd55e8`. Post-PR #36 `master` base `cb93ddceed6aa9dbcfa00a553e2b88be18cfd452`.

CI: [CA-02 Real-world Evaluation #43243541262](https://github.com/caongocquy/code-atlas/actions/runs/43243541262). Exact tested code HEAD `f78aa2cf1b4a1a4eca470a434530f36070ce6347`.

| Pipeline stage | Observed | Interpretation |
| --- | ---: | --- |
| JS/TS tracked source files | 17 | Pinned project scope |
| Parser-extracted callsites | 4,099 | Parser census, not source-independent annotation |
| Persisted resolver call decisions | 4,099 | **No parser → resolver callsite loss** |
| Resolved call decisions | 1 | Only one accepted target under current policy |
| Unresolved call decisions | 4,098 | Main coverage bottleneck is the resolver's ability to establish an unambiguous supported target |
| Ambiguous decisions | 0 | No explicit ambiguous call decisions published |
| Published `calls` edges | 1 | **No loss from resolved decision to graph publication in this run** |
| Resolved decisions without published edges (simple count lower bound) | 0 | Consistent with one accepted target and one edge |
| Edge provenance records | 2 | Evidence entries, **not distinct callsites** |
| Unsupported dynamic diagnostics | 17 | Subset of unresolved diagnostics |
| Parse-diagnostic files | 0 | No reported parse errors; does not guarantee semantic correctness |
| Same-line ambiguous source callsite entries | 1,189 | Source attribution limitation in review packet |
| Review sample complete | 0/160 | No independent source ground truth yet |

Persisted `getGraphResolutionDiagnostics` histogram has `unresolved:unknown = 10,925` entries. **This count is across multiple graph relation kinds (including references), not 10,925 unresolved calls.** Always use persisted call-specific coverage for call counts, not this histogram's grand total.

## Root-cause boundary

The **observed pipeline bottleneck is target resolution**: every parser callsite generated a persisted resolver decision, and every resolved call decision corresponds to the published graph edge. There is no evidence in this run of lost callsites during facts ingestion, dropped resolved edges during persistence, or a broken MCP presentation layer.

However, the **semantic root cause of 4,098 unknown decisions has not been independently adjudicated**. Many may target dependencies or runtime/dynamic constructs not represented by the indexed source, so this is **not a 0.024% recall estimate**. Potential contributors to audit, not verified bugs, include local binding/function identity, method receiver type inference, cross-module imports, framework callbacks, and cases outside supported static resolution.

## Decision and next experiment

1. **Do not broaden target matching by name.** Keep the fail-closed exact/strong strategy and existing false-positive protections.
2. Take a source-backed stratified review of `unresolved:unknown` decisions. For each reviewed call, label in-repo static target, external dependency target, runtime dynamic or genuinely ambiguous; record caller, callee, source line, expected file-qualified symbol, existing facts and strategy evidence.
3. Prioritize cases with verifiable in-repo targets as regressions. Add small failing tests **before** any resolver fix, and report false-negative count only for adjudicated positives.
4. Rerun the pinned corpus; compare parsed callsite counts, resolved/ambiguous/unknown counts, forbidden edges, accuracy on reviewed labels, and exact-head CI.
5. Do not mark CA-02 Done until independent review and wider repository evaluation. G2/G3/D16 gates are not modified by this PR.

**This PR is diagnostic instrumentation/CI only, not a production resolver change.**
