# CA-02 — Edge correctness and provenance audit

Date: 2026-11-08  
Pinned source: `65078cf878099dedf3ceac36fafa9675dc09468b` (master)  
Scope: audit and baseline design only. No production changes, release, or modification of index/storage versions.

## Established source facts

1. `src/core/graph/resolver/resolver.ts` collects candidates from ordered strategies and optionally SCIP, then uses `uniqueTargetGate`.
2. `src/core/graph/resolver/decision.ts` merges evidence IDs by logical target, rejects weak-only cases, records budget exhaustion and explicit ambiguity, and produces `resolved`, `ambiguous`, `unknown`, or other nonresolved states.
3. `src/core/graph/resolver/scip-evidence.ts` includes a source range and site-local ID for a SCIP binding.
4. `src/core/graph/resolver/provenance.ts` exposes `withProvenance`, validates canonical source/target logical IDs and exact/strong confidence, sorts evidence, and bounds compact evidence to 8 entries.
5. `src/core/graph/types.ts` already makes `GraphEdge.resolution?: EdgeResolutionProvenance` optional, along with legacy `resolutionMethod`, `evidenceKind`, and `resolutionSource`.
6. `src/core/graph/build-graph.ts` `assembleFactsGraph` (lines 374–396 in pinned HEAD) iterates only resolved decisions, maps logical symbols to graph IDs, then pushes `{ from, to, type }` with no `resolution` or callsite span. For this exact assembly path, edge provenance is not directly attached. Whether another downstream step enriches it remains UNVERIFIED.
7. `build-graph.ts` has other/legacy assembly paths; do not extrapolate a finding from one path to every graph mode.

## Existing regression coverage inspected

- `test/phase14b-resolver-decisions.test.ts`: strong unique, ambiguous, weak-only, budget, and sorted merged evidence.
- `test/phase16b-scip-resolution.test.ts`: exact SCIP target, matching parser+SCIP candidates, conflicting candidate ambiguity.
- Other existing suites visible by name: `phase14b-resolver-contract`, `phase14b-resolver-determinism`, `phase14b-typescript-member-calls`, `phase16b-scip-evidence`. Names do not constitute proof of individual assertions.

## Risks and hypotheses — not yet established bugs

- Loss of provenance in graph serialization and public MCP inspect/search.
- Incorrect cross-module re-export, import-alias or scope candidate acceptance.
- Member method/overload ambiguity and false-positive edges for bare calls.
- Loss of unresolved/ambiguous diagnostics across incremental generation.
- Graph edge dedup by `from:to:type` potentially collapsing independent callsite evidence; must test desired contract before changing it.

## Baseline execution status

GitHub source inspection completed. The GitHub connector does not execute checked-out project tests, and this environment cannot resolve github.com for a local clone. No focused suite or gold-fixture evaluation was executed; precision, recall, FPR, FNR, latency, memory, and incremental parity remain **UNMEASURED**. Do not claim green tests or zero regressions from this audit.

## Proposed gold fixture design

Use a deterministic, single-repository JS/TS fixture with explicit expected and forbidden edges. Cover:
- Two functions of the same name in distinct lexical scopes.
- Renamed imported symbol and re-export chain.
- Member call where two classes implement the same method name.
- Unknown dynamic receiver; must remain unresolved.
- SCIP exact target versus conflicting parser target; must be explicit ambiguous unless reviewed precedence contract says otherwise.
- Independent callsites of the same caller/callee with distinct source spans.

Gold evidence should specify source file, callsite line, expected logical target(s), and required nonresolved status. Do not treat `contains` or `imports` edges as call edges. Avoid estimating precision/recall from a fixture that does not include negatives.

## Suggested next commands (in a real checkout)

1. `git rev-parse HEAD` and ensure this audit's pinned SHA matches the baseline.
2. Install exact package manager from package manifest and `pnpm install --frozen-lockfile`.
3. Run existing focused resolution/SCIP/facts tests using the repository's configured TS test runner.
4. Build an executable gold-fixture harness; compare `assembleFactsGraph`, persistence reload and MCP projections against expected edge identities and callsite metadata.
5. Measure TP/FP/FN, latency, calls/queries and graph generations; repeat clean versus incremental. Validate deterministic output across Linux/Windows/macOS.

## Decision / hold

**Audit in progress; implementation NO-GO until a reproducible failing case and an executed baseline exist.** Do not silently elevate weak candidates, change public MCP defaults, overwrite graph identity, or grant CA-01 release/security waivers. GitNexus impact and detect_changes tools were not available in this connected environment; no production symbol was edited.
