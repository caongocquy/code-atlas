# CA-01 opt-in MCP context qualification

Target: master `d2570bd789095d82442ff332beb36a5ddd998194`. Date: 2026-10-21.
**Release decision: NO-GO.** Policy B (approved zero-regression with baseline debt)
is recommended conditionally and has not been approved. No remote candidate CI,
commit, PR, merge or release is implied by these local measurements.

## Contract

The optional `response` property supports compact/focused/full, section and relation
projection, `maxOutputBytes` for the complete MCP CallToolResult (text plus
structuredContent), approximate `maxOutputTokens`, per-top-level-collection
`pageSize`, and signed query/generation/snapshot-bound continuation cursors.
Without `response`, the existing handler and legacy payload path are unchanged.
Projection does not reorder retrieval ranking. Clients can request full evidence
or follow continuation; smaller results may grow because explicit metadata costs
bytes. Tokens are estimates, not model-specific guarantees.

## Local evidence

Original focused MCP/Phase16C suite: **54 pass, zero failures/skips**. Baseline
full suite: 1435 tests, 1384 pass, 48 fail, 3 skip. Original CA-01 candidate:
1446 tests, 1395 pass, 48 fail, 3 skip. Full assertion/error/cause-tree comparison:
48 equivalent, zero added/removed/changed failures. Strict green-suite gate FAIL.
The CI tooling unit adds its own tests; counts must be measured per revision,
Node and platform, never pinned to 48 as a universal expected count.

Existing baseline failures: 33 workspace framework-version certification mismatches;
3 stale facts-version assertions; 2 fact-ID/scope contract mismatches; 1 export-star
omission; 1 missing variable-symbol/chunk case; 5 missing caller-identity/call-edge
cases; 2 partial-facts/framework publication-policy conflicts; 1 fallback-counter
expectation. Owners are the workspace reader, version contracts, ECMAScript facts,
graph resolver and indexing/publication subsystems. Scope ownership and intended
fallback policy need maintainer decisions; no assertions or graph semantics were
changed. Complete historical evidence stays local, unchanged. An approved debt
register and exact-candidate supported CI evidence are still required.

Legacy parity: 11 complete payload comparisons (only volatile root inspection
metrics excluded), plus schemas/annotations after removal of the optional response
property. React/Vite source indexes successfully. The deep fixture persists 24
nodes and 23 declared call edges; it qualifies SQL hydration/traversal and nonempty
continuation, not parser inference. Tests exercise budgets/Unicode, deterministic
ordering, malformed filters, signed cursor mismatch/expiry/restart, concurrent
clients and index-generation invalidation.

Real semantic evidence: cached Xenova/all-MiniLM-L6-v2 revision
`751bff37182d3f1213fa05d7196b954e230abad9`, dimension384; production OpenAI-compatible
provider path backed by actual local inference. Nine requests embedded ten texts;
identity/ranking/fusion scores agree across four modes. SDK cancellation/timeout
and recovery pass, but synchronous SQL/projection is not preemptible and provider
work may finish after client cancellation. No model download is needed for offline CI.

## Same-target benchmark

Node22.23.2/macOS arm64, identical dependencies/parser payload, fixtures and retrieval
configuration; 12 samples after warmup. Bytes include text and structuredContent,
not JSON-RPC framing. Token estimates use serialized UTF-16 length/4.

| Workload | Legacy bytes | Focused bytes | Reduction | p50/p95 ms legacy | p50/p95 ms focused | SQL legacy/focused |
| --- | ---: | ---: | ---: | --- | --- | --- |
| large lexical | 887978 | 152360 | 82.8% | 18.67/26.07 | 17.85/19.83 | 56/66 |
| hybrid fallback | 1781308 | 157978 | 91.1% | 21.51/26.33 | 19.04/20.73 | 58/68 |
| repeated stages | 860359 | 106780 | 87.6% | 14.01/14.96 | 13.34/14.25 | 9/19 |
| real React | 143632 | 23844 | 83.4% | 15.66/17.29 | 16.27/18.22 | 56/66 |
| small symbol | 1834 | 2334 | -27.3% | 16.35/18.58 | 16.20/17.63 | 56/66 |
| empty | 348 | 1046 | -200.6% | 18.49/24.20 | 15.51/16.58 | 56/66 |

Ten extra SQL executions remain: two fresh generation reads. Reusing an immutable
SQLite reader missed generation publication without WAL; correctness took priority.
Complete-window fast path avoids unused canonical continuation serialization.
Alternating same-payload projection median focused1.079→0.564ms, full4.877→2.600ms
(60 samples) is historical profiling evidence, not retrieval latency or an SLA.
Fresh-process large lexical high-water RSS: legacy244144KiB, focused231920KiB,
full240080KiB; includes initialization/warmup, not exact response allocation peaks.
No general latency or memory guarantee is claimed.

## Compatibility and remaining gates

PASS, scoped: SDK in-memory, built/packed stdio, clean npm consumer, macOS arm64,
Codex native and OpenCode2.1.0 actual legacy/focused MCP invocations. OpenCode's
correct v2 configuration uses mcp.servers; a later agent refusal despite discovery
shows selection variability. Native OpenCode custom byte-budget transmission was
not proven; separate SDK/packed proofs enforce budgets.

Claude2.1.303 initialization/discovery passes (41 tools); live invocation NOT RUN
because its configured localhost model gateway refused connections. A prior
native CLI startup automatically wrote global bookkeeping despite no-session-
persistence. No full delta was proven. This preparation never launches native
agents or accesses their settings; future runs require isolated native state.

Linux x64/glibc packed smoke passes on Node22.23.3 Debian12/glibc2.36 under x64
emulation. It is not full remote Linux or Node24 qualification. Certified tuples:
darwin-arm64, darwin-x64, linux-x64, win32-x64. Alpine/musl arm64 is outside that
matrix. Windows/macOS x64/full remote matrix and candidate CI remain NOT RUN.
Cursor is unavailable. No waiver, Done status or merge approval has been granted.

## Reproduction

Build first: `npm run build`; typecheck: `node_modules/.bin/tsc --noEmit`; lint:
`npm run lint`; offline context: `CODE_ATLAS_EVAL_OFFLINE=1 npm run eval:context`.
Use the repository's pinned Node22/24 and parser-distribution preparation.

Original focused checks:

```sh
node --import tsx/esm --test test/ca01-mcp-response.test.ts test/ca01-response-budget.test.ts test/ca01-mcp-stdio.test.ts test/ca01-qualification.test.ts test/phase14g-mcp-response-efficiency.test.ts test/phase15e-mcp-metadata.test.ts test/phase16c-a-metrics.test.ts test/phase16c-a-dataset.test.ts test/phase16c-b1-lexical-ranking.test.ts test/phase16c-b1-hybrid-ambiguity.test.ts test/phase16c-b3-owner-aware-lexical.test.ts
node --expose-gc --import tsx/esm eval/mcp/benchmark.ts artifacts/ca01-benchmark.json legacy compact focused full
node --import tsx/esm eval/mcp/legacy-parity.ts BASELINE_ROOT
```

BASELINE_ROOT must be an explicitly prepared clean checkout of the pinned target
with matching installed dependencies/parser payload; the parity script shares
fixtures across both servers. It requires no hidden sibling worktree. Optional
real-provider replay uses `eval/mcp/semantic-qualification.ts` with a pre-populated
`artifacts/semantic-runtime` model cache; allowRemoteModels=false. Do not interpret
a missing model cache as an offline-contract failure. Raw sessions, caches,
models, tarballs, databases and CPU dumps are intentionally not source-controlled.

Opt-in relation responses expose `output.resultCounts.beforeFilter` and
`output.resultCounts.afterFilter` for the handler's bounded result window, before
pagination. `totalReturned` counts only `results` in the current page, including
zero after full filtering. These counts are not repository-wide totals. Calls
without response options retain the legacy handler contract.
