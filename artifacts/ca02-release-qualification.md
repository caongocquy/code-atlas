# CA-02 Release Qualification — Scoped Evidence

## Decision

**Evidence gained; CA-02 remains In Progress.** This is a qualification-only PR, not a production resolver change. The small gold fixtures pass and scoped MCP compatibility holds, but an independently labeled real-repository evaluation and complete public MCP output compatibility audit remain outstanding. G2/G3/D16 release controls are unaffected.

## Tested base and baseline

- Post-PR #33 `master`: `8946e8dd9bf687ccf39dcfd7a61873c98de21220`.
- Historical CA-02 audit baseline: `65078cf878099dedf3ceac36fafa9675dc09468b`.
- Draft PR: [#34](https://github.com/caongocquy/code-atlas/pull/34).
- The first Linux MCP comparison attempt failed to start the old server because its native Tree-sitter runtime had not been prepared. Both checkouts were subsequently compiled from their pinned dependencies before comparing real stdio MCP servers. That initial harness failure is not evidence of an API incompatibility.

## Baseline/current public MCP compatibility

CI [#43047867494](https://github.com/caongocquy/code-atlas/actions/runs/43047867494) successfully executed `scripts/ca02-mcp-contract-comparison.mjs` through the actual MCP Inspector stdio protocol:

| Check | Audit baseline | Current | Result |
| --- | ---: | ---: | --- |
| Tool count | 41 | 41 | Pass |
| Removed tool names | — | 0 | Pass |
| Added required input fields | — | 0 | Pass |
| Removed input properties | — | 0 | Pass |
| Removed `repository_status` envelope keys | — | 0 | Pass |
| Removed `repository_status.structuredContent` keys | — | 0 | Pass |

**Bounded scope:** This is a real baseline-vs-current compatibility comparison of tool availability, input schema compatibility and one stable response envelope. It is **not** byte-for-byte output comparison for every MCP tool, including all graph-query outputs or dynamic resolution/provenance values. Consumers should not interpret this as universal semantic parity.

## Labeled accuracy and parity

- Original CA-02 source/line gold corpus: **5/5 labeled positives matched, no forbidden matches** on current post-PR #33.
- Expanded author-labeled TypeScript corpus: **9/9 labeled target relationships matched, no forbidden matches**. Exercises named nested calls, typed class methods, same-name decoys, reexported imports, cross-calls and typed construction. Seven explicit forbidden relationships protect negative cases. Repeated calls on the same source line are treated as one labeled relationship in the expanded measurement.
- Expanded clean-vs-incremental parity after edits: PASS.
- On the combined *small fixture labels*, labeled recall is 14/14 and no forbidden matches were observed. **Do not report 100% global precision/recall**: both oracles are compact and partly author-labeled, and unlabeled graph predictions or independently adjudicated real-world data were not exhaustively checked.

## Platform coverage

- macOS 15, Node 22.23.3: native parser preparation, typecheck, original gold, expanded gold, typed receiver and incremental parity **SUCCESS** ([CI #43047867494](https://github.com/caongocquy/code-atlas/actions/runs/43047867494), 8/8 tests).
- Linux Ubuntu 22.04, Node 22.23.3: baseline/current MCP Inspector comparison, current typecheck and native parsers, original+expanded gold tests **SUCCESS** in the same run (5/5 tests).
- Windows 2022, Node 22: original CA-02 final validation gold/parity **SUCCESS** on [PR #33 CI #42847726074](https://github.com/caongocquy/code-atlas/actions/runs/42847726074). The new expanded corpus was not separately executed on Windows in this PR.

## Outstanding acceptance work

1. Independently label and run a larger real-world JS/TS/TSX corpus including ambiguous/cross-file cases, then report TP, FP, FN and reviewer-audited correctness on actual codebases.
2. Extend response compatibility checks to representative graph-query tools (`get_symbol`, `find_callers`, `find_callees`, `trace`, `inspect_change`, etc.) with intentional version-aware normalization rather than requiring equal graph accuracy.
3. Review PR #34 and all exact-head CI outcomes; only then consider merging validation assets or changing CA-02 status.
