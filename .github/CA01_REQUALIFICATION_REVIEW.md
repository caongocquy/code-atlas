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
