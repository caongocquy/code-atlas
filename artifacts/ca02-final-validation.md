# CA-02 Final Validation — Qualification Record

**Decision: NO-GO for CA-02 Done.** The merged Step 1–4 implementation materially improves source-backed call resolution, but the preserved gold oracle still has one unresolved expected positive, and broader repository-scale evaluation has not been run.

## Scope and provenance

- Tested base: `master` merge commit `9cfb31e80f02621d6397ba9bf0269c7378decc2f` (after PRs #28, #29, #30, #31).
- Oracle: exact copies of `test/fixtures/ca02-edge-audit/{source.ts,reexport.ts,consumer.ts,gold.json}` from unmerged audit-only PR #27. Labels and forbidden entries are unchanged. This report's code contains no production modifications.
- Audited baseline: `65078cf878099dedf3ceac36fafa9675dc09468b`, historical CI [#42490823628](https://github.com/caongocquy/code-atlas/actions/runs/42490823628): 0/5 expected callsites resolved, no forbidden matches, labeled precision undefined (no positive predictions).
- Current CI [#42843425682](https://github.com/caongocquy/code-atlas/actions/runs/42843425682) on PR #32 (initial measurement at `86ad8cfbbee0078a78e6094acf05b32942754ad1`): 4/5 expected callsites resolved, no forbidden match, labeled recall **80%** (+80 percentage points), **labeled precision 100%** among labeled predicted positives. These are **fixture-specific**, not a global precision or recall estimate.

## Observed current matches

| Oracle callsite | Expected target | Measured |
| --- | --- | --- |
| `source.ts:9` `outer` | `outer.target` | Resolved, lexical-local / strong |
| `source.ts:25` `invokeKnown` | `First.work` | **MISS**: typed receiver member resolution remains unsupported in this scenario |
| `source.ts:33` `invokeTwice` | `target` | Resolved, lexical-local / strong |
| `source.ts:34` `invokeTwice` | `target` | Resolved, retained as distinct source line on same edge |
| `consumer.ts:4` `viaAlias` | `target` | Resolved, imports-exports / strong |

`invokeUnknown` intentionally remains without a concrete call edge; its structural assertion is not proof of a unique implementation. Forbidden top-level shadow or wrong-member edges were absent in the labeled results. Eight-evidence cap remains unchanged; beyond eight callsites the compact graph record is incomplete by design.

## Validation coverage

- **Linux**: native parser preparation; TS typecheck; 17/17 gold and CA-02 regression tests passed; MCP Inspector 2.7.0 exercised actual stdio `initialize`, `tools/list`, tool annotations/input schemas and tool calls, 1/1 passing.
- **Clean vs incremental parity**: exact call/target/source-line semantics after a non-semantic edit on gold corpus; and existing PR regression fixtures for re-export changes and callsite removals.
- **Windows**: Windows 2022 Node22 job in [CI #42843425682](https://github.com/caongocquy/code-atlas/actions/runs/42843425682) **SUCCESS** (typecheck, native parser preparation and gold/parity tests).
- **Limitations**: MCP Inspector is a current-head conformance test, **not** a byte-for-byte public payload comparison with the baseline commit. No macOS CI; no repository-scale labeled precision/recall; no end-to-end demonstration of inferred-vs-confirmed markings across all inspect/search tools.

## Recommendation

Keep CA-02 **In Progress**, PR #32 **Draft** for evidence and review, and fix `First.work` typed receiver resolution in a narrowly scoped follow-up before deciding whether to enforce 5/5 oracle recall. Then add explicit MCP baseline/current schema and response-contract comparisons plus a larger corpus with adjudicated labels. Do not treat the 4/5 result or green CI as authorization to bypass G2/G3/D16 release gates.
