# CA-01 — frozen-target requalification review (NO-GO)

Status: **REVIEW REQUIRED / NOT APPROVED**. Prepared 2026-11-18. This is an
evidence ledger and approval checklist, **not** a new baseline, an oracle update,
a differential gate waiver, or merge/release authorization.

## Frozen contract and evidence provenance

- Immutable CA-01 integration target: `d2570bd789095d82442ff332beb36a5ddd998194`
  (see `docs/ca01-qualification.md` and
  `.github/workflows/tree-sitter-installation.yml`).
- Policy B (zero regression with documented baseline debt) is **unapproved**.
  Strict all-green and differential checks must remain visible and independent.
- Current integration branch when reviewed: `master` at
  `eeb5a33584f19af71871c7e09c21a6e21cf7c111`; PR #42 diagnostic
  head when this review was prepared: `d83083e6c3580762c53250280d2c671a69c3e4ee`.
- Linux Node 22 raw frozen comparison: GitHub Actions run
  [44062056016](https://github.com/caongocquy/code-atlas/actions/runs/44062056016),
  artifact `ca01-linux-x64-node22.23.3` (ID `14318802843`).
  Files inspected: `.evidence/{baseline,candidate}.jsonl` and
  `.evidence/comparison.json`.
- Successful independent retrieval diagnostic: run
  [44062075080](https://github.com/caongocquy/code-atlas/actions/runs/44062075080).
  Full artifact [14317024222](https://github.com/caongocquy/code-atlas/actions/runs/44060354125/artifacts/14317024222)
  provides original per-case and per-profile payloads.

## Qualification failure ledger

| Category | Evidence | Disposition |
| --- | --- | --- |
| Target identity | All eight OS/Node push-triggered CA-01 jobs at [run 44224755230](https://github.com/caongocquy/code-atlas/actions/runs/44224755230) fail `Verify target and equivalent dependency inputs`: current PR integration target no longer equals pinned CA-01 target | **BLOCKED**; separate explicit target approval and requalification required |
| Frozen strict test gate | Baseline 1,435 tests, 48 failures; candidate 1,541 tests, 48 failures, 3 skips on each | **FAIL** on both revisions; matching failure counts are not a waiver |
| Frozen differential | 44 equivalent baseline failures, 4 newly failing tests, 4 formerly failing tests now passing, 11 missing exact test identities, no changed failure fingerprints or new skips | **FAIL**; both changed outcomes and coverage need decision |
| Phase14B semantic floor | 3 new failures: `all target-language fixtures satisfy the applicable semantic floor`; `conformance decisions and persisted edge projections are deterministic across cold, warm, and parallel runs`; `independent worker resolver jobs overlap and remain deterministically equivalent` | **OPEN**: TypeScript expected method target is `refresh`, current extractor/resolver target is `Service.refresh` |
| B4A strict fingerprint | 1 new failure in `B4A keeps parser-only retrieval stable and aligns TaskContext and SCIP evidence paths` | **OPEN**: original `0f1cc2dfb47f1c2f887843440cf50ea415c07abee2e402fc23b42e6e04a82979`, candidate `cbf14f804c9d10c0fc37fdd9c401e5ba349069314fcbd8f5e1e5013f60b9808e` |
| Exact test identities | Of 11 baseline identities missing by full `(file,line,column,nesting,name)`, 10 still pass with new source locations and 1 was deliberately removed | **OPEN**: do not treat removed coverage as a harmless location move |

### Semantic evidence requiring review

1. TypeScript `Service.refresh`: `src/core/facts/extractors/ecmascript.ts`
   intentionally qualifies methods with their owning class to distinguish
   identical short names. `test/fixtures/phase14b/typescript/expected.json`
   still contains bare `refresh`. CI actual preserves the same symbol
   discriminator (`symbol:13`), source unit and resolver evidence, but uses
   the owner-qualified method name. CA-02 #33 (`8946e8dd9b`) introduced
   class-qualified typed receiver semantics. The independent method regression
   in PR #42 passed; **this does not authorize changing the expected oracle**.
2. B4A: 40 cases compared; 29 cases and 79 case/profile pairs differ. Of these,
   75 lexical and 75 hybrid pairs differ in candidate metadata/identities without
   a change to ordered retrieval results or metrics in those stages. Six
   hybrid-graph-expansion pairs change ordered candidates, with six graph
   expansion relation deltas (additional/rescoped `calls` evidence).
   The separate seven-metric guard records 0 degraded metrics and 4 improvements.
   A non-regression on these metrics does **not** guarantee total behavior parity
   or justify silently replacing the full-payload SHA.
3. Exactly one removed historical test name:
   `TypeScript unique-or-drop rejects unrelated same-name method`.
   It was intentionally removed in CA-02 #33 because correctly typed `B`
   must resolve to `B.list` despite `A.list`. PR #42 now adds a positive
   test with the historical A/B/service fixture. This restores behavioral
   coverage but cannot make an old test identity reappear in frozen comparison.
4. The existing comparator in `scripts/compare-ca01-tests.mjs` must remain
   authoritative. The new `scripts/ca01-test-identity-audit.mjs` is an
   **independent, non-waiving diagnostic** for explaining moved/removed/changed
   tests and cannot redefine a qualifying differential PASS.

## Approval gates — all required before merging or releasing

- [ ] Maintainer identifies the **specific target commit** to requalify and
      records approval with the reason the frozen `d2570bd` target is obsolete.
- [ ] Phase14B semantic owner reviews owner-qualified method identity, resolves
      three fixture failures and records expected/actual evidence. No silent
      oracle rewrite or unnecessary resolver regression.
- [ ] Retrieval owner reviews six hybrid-graph-expansion ranking changes, graph
      edges, potential false positives and full B4A payload, not just metric
      aggregates, before authorizing any fingerprint change.
- [ ] CI owner reviews the 11 missing exact identities and eight outcome flips,
      including the single removed negative test; confirms replacement behavior
      and explicitly approves how the comparator is applied for a new target.
- [ ] Every baseline-debt failure has an owner, tracked justification and
      explicit Policy B approval **or** all strict-green failures are fixed.
- [ ] Re-run the existing full CA-01 matrix on the **approved target** for
      darwin-arm64, darwin-x64, linux-x64, win32-x64 and Node 22.23.3/24.21.0
      with pinned dependency inputs. Upload full comparison and consumer evidence.
- [ ] Independently verify legacy MCP behavior, compact/focused/full budgets,
      signed pagination, cancellations, and release policy as documented in
      `docs/ca01-qualification.md`.
- [ ] Record a final explicit merge/release authorization only after passing
      the approved gate. **No automatic authorization from diagnostic PASS.**

## Current recommendation

**Remain NO-GO.** Keep PR #42 draft, PR #40 unmerged, frozen comparator/oracle,
and original target unchanged. Request a decision on the new integration target
and semantic contracts before implementing any approved oracle or policy
migration. Continue to use independently green CI as supporting evidence, not
a substitute for failed CA-01 release qualification.


## Post-rollback strict-green debt inventory — 2026-11-19

Evidence: [proposed-target Linux Node 22 run #44438403956](https://github.com/caongocquy/code-atlas/actions/runs/44438403956), artifact `ca01-proposed-target-linux-node22` (ID `14490331296`). Candidate `7237a32332f3e810c72ca112ef8da09977e4b6d9`; proposed base `eeb5a33584f19af71871c7e09c21a6e21cf7c111`. Full differential **PASS** with 14 equivalent failures, zero added/changed/skipped/missing identities, and 34 baseline failures corrected since the initial 48. **Strict-green remains false**.

| Group | Count | Exact remaining failures | Evidence / disposition |
|---|---:|---|---|
| Phase14A graph parity | 2 | `facts graph preserves clean-fixture graph nodes and edges`; `incremental graph matches a clean full rebuild for imports, calls, extends, malformed, delete, and rename` | Missing inferred same-file `calls` edge in graph comparison; malformed incremental update returns `failed` instead of expected `published`. Do not restore speculative edges or relax publication integrity without semantic/security review. |
| Phase14A local identity/containment | 2 | `extracts one path-neutral fact blob from a TypeScript source snapshot`; `records containment ownership for symbols, calls, and references` | Current unified fact sequence yields `symbol:13,15,27,33` instead of legacy `symbol:1..4`; current scope is `scope:2` vs expected `scope:1`. Review consumers before altering IDs. |
| Phase14A publication/counters | 2 | `malformed source publishes reusable deterministic partial facts`; `index work counters observe importer invalidation and uncertain resolution fallback` | Current malformed source rejects publication; importer counter observed 0 vs expected 1. Requires integrity and invalidation contract decisions. |
| Phase14A parse/lexical | 2 | `facts graph does not parse again for member and extends resolution`; `facts materialization preserves columns for same-line symbols` | No inferred member call (expected 1); no symbol-derived chunks for `const first/second`. Previous attempt to emit global `variable` symbols caused 7 new and 4 changed failures plus lazy-route regressions (run #44286862548); **reverted**. Any future lexical fix must be isolated from shared symbol/graph identities. |
| Phase14A template call evidence | 2 | `facts member evidence preserves executable template interpolation`; `facts evidence handles nested template interpolation and masks nested regex literals` | Expected one resolved member call, actual zero. The masker assertions are not sufficient to certify receiver-member resolution; review CA-02 typed-receiver safeguards before changing call edges. |
| Phase14B TypeScript semantic oracle | 3 | `all target-language fixtures satisfy the applicable semantic floor`; `conformance decisions and persisted edge projections are deterministic across cold, warm, and parallel runs`; `independent worker resolver jobs overlap and remain deterministically equivalent` | `Service.refresh` vs legacy `refresh`. Semantic behavior changed intentionally in CA-02; independent oracle-owner approval required, no automatic oracle rewrite. |
| B4A retrieval fingerprint | 1 | `B4A keeps parser-only retrieval stable and aligns TaskContext and SCIP evidence paths` | Full-payload SHA differs; six hybrid graph-expansion ranking deltas documented above. Requires owner review before fingerprint update. |

**Total 14**: 10 Phase14A, 3 Phase14B, 1 B4A. No remaining `workspace_package_links` or Go deterministic extraction failures in this proposed-target artifact.

### Follow-up engineering boundaries

- A production fix may be kept only after the focused original failing test **and** complete cross-OS workflow/differential evidence show no added/changed failures or graph/retrieval regression. The rollback shows that treating a legacy lexical oracle as authority over global symbol shape is unsafe.
- No automated rewriting of Phase14B `expected.json`, B4A full-payload fingerprint, historical test identities, strict comparator, original target `d2570bd` or Policy B.
- The proposed-target run is *diagnostic*, not release qualification. Resolve explicit owner approvals or make the remaining 14 genuinely strict-green before requalification.


## Portable release gate: separate target and incident — 2026-11-19

The portable matrix compares against an **independent, immutable release base**
`8f3c2d7671b4d9a9deaa70c83c80c4fccb94689f`, not CA-01's proposed
`master` target `eeb5a33584f19af71871c7e09c21a6e21cf7c111`.
Evidence: [portable run #44442522585](https://github.com/caongocquy/code-atlas/actions/runs/44442522585),
macOS Intel uploaded `portable-candidate-darwin-x64` artifact `14492961196`,
`.evidence/regression-comparison.json`. The release comparator reports **three
added assertion failures**, zero changed failures and zero new skips:

1. `test/phase14b-conformance.test.ts :: all target-language fixtures satisfy the applicable semantic floor`
2. `test/phase14b-conformance.test.ts :: conformance decisions and persisted edge projections are deterministic across cold, warm, and parallel runs`
3. `test/phase16c-b4a-measurement-parity.test.ts :: B4A keeps parser-only retrieval stable and aligns TaskContext and SCIP evidence paths`

These are **not** evidence that the portable archive, native parser loading or
package bundling generated three new defects. They come from the historical
release baseline's Phase14B owner-qualified `Service.refresh` change and the
B4A full-retrieval fingerprint. The proposed-target CA-01 differential passing
does **not** authorize changing this independent release comparison base,
relaxing the release comparator or rewriting the expected artifacts.

A separate infrastructure failure occurred in the macOS Intel ONNX source
checkout: `git fetch` for pinned
`microsoft/onnxruntime@f2c39fe2f838cf35ce7da92824f5a5e3ee6e88a7`
returned `fatal: repository ... not found` with exit 128 on three action
attempts. This is an upstream checkout availability/access incident, not the
release assertion cause. Do not switch to an unverified mirror, move the pin
or skip the ONNX build. Recheck upstream access and integrity before re-running.

The portable workflow now writes **exact added/changed/skipped test identities**
to job logs and GitHub job summary when the strict release comparison fails;
the failure gate still exits nonzero and uploads the same evidence artifact.
**Disposition:** release baseline/oracle approvals and independent ONNX availability
are outstanding. PR remains NO-GO.
