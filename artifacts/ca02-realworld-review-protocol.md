# CA-02 — Real-world accuracy review protocol

## Status and scope

**Evaluation infrastructure, not an independently adjudicated accuracy score.** This workflow runs the current Code Atlas facts parser and graph index on a pinned open-source repository, exports per-callsite predicted targets, and creates a review packet. All labels start `pending`; **precision, recall, TP/FP/FN must remain null until review finishes**.

- Repository: [sindresorhus/p-queue](https://github.com/sindresorhus/p-queue), pinned at `7f272ab5ff2254c0dc2537b7977e88ede1cd55e8`.
- Source scope: tracked `js/jsx/ts/tsx` files, excluding `.d.ts` and generated dependency/build directories. No code from the evaluated repository is executed; source is parsed/indexed only.
- Provenance: pinned SHA and file list in packet, no floating branch or uncontrolled source downloads.
- Output: [workflow](https://github.com/caongocquy/code-atlas/actions/workflows/ca02-realworld-review.yml) artifact `ca02-pqueue-review-packet` with deterministic 160-callsite review sample, full raw callsite census and pending score.
- Existing Phase15D corpus contains 4 small genuine pinned snapshots with license notices, but these isolated files are insufficient to estimate a project-scale call graph; this runner uses a larger pinned public TypeScript repository.

## Reviewer process

1. Download the packet from the exact-head successful GitHub Actions run. Compare its `selection` metadata against the full-census packet (all extracted callsites). The default review packet contains up to 160 callsites, selected deterministically with priority given to predicted targets and at least one callsite per included source file. This **nonprobability sample** must not be presented as a full repository evaluation. Inspect `provenance`, the selected file list, `parseDiagnostics` and every `sites` entry.
2. A reviewer **other than the implementation author** verifies each callsite using the pinned source. For every entry, set `review.status`:
   - `resolved`: the correct static target(s) are known and uniquely attributable. Populate `expectedTargets` using **both** `targetFile` and `to` qualified symbol.
   - `unresolved`: the callsite has no valid in-scope target. Use `expectedTargets: []`; any predicted target may be a false positive.
   - `external`: target is outside the indexed snapshot or language/source scope; use `expectedTargets: []`, excluded from precision/recall by policy.
   - `ambiguous`: multiple calls on one source line, dynamic dispatch or source ambiguity cannot be disambiguated reliably; use `expectedTargets: []`, excluded by policy but **must** be counted/reported.
   - `pending`: not yet reviewed, metrics must stay null.
3. For every adjudicated item provide `reviewer` and concrete `notes` citing the source/target symbols and why the label is valid. Never infer labels from Code Atlas prediction output.
4. Run `node --import tsx/esm eval/ca02/score-realworld-review.ts --input reviewed-packet.json --output scored.json`. **Only if every item **in the selected packet** is reviewed** will this produce TP, FP, FN, precision and recall. Null denominators remain null (never silently 100%). Deduplicate predicted targets by `targetFile` and qualified target name.
5. Have a second reviewer spot-check correctness and ambiguous exclusions before claiming independent ground truth. Record reviewer IDs, review SHA and corpus SHA. This policy cannot technically verify reviewer independence; it is a documented manual release gate.

## Known measurement limitations

- Compact graph edge provenance retains at most eight evidence records, and several function calls can occupy the same line. Packet suppresses line-level predicted attribution when multiple callsites share a line; those sites should be marked ambiguous until site-level evidence is available. This creates a conservative blind spot.
- Parser status and diagnostic files are recorded. The human reviewer must classify missing parse coverage; callsites absent from the parser are outside this packet's recall denominator. For **full source-level recall**, an independent AST/source auditor must enumerate missing callsites separately.
- `resolved` status is source-level ground truth, not evidence that an edge was produced; the reviewer must verify targets independently.
- The default 160-callsite sample is nonrandom and overrepresents predicted sites; its precision and recall cannot be extrapolated to the full 4k+ callsite population. The full census artifact remains available for separate independent source-level review. This one pinned repository primarily exercises TypeScript. JS/TSX and wider language coverage need more real repositories, not fabricated labels or synthetic performance extrapolation.
- Review and accuracy claims remain **NO-GO** until all labels are completed, the exclusions are audited, and the independent source-level audit exists.

## Acceptance for this infrastructure PR

- Clean pinned checkout verified against exact commit.
- Typecheck, native Tree-sitter prepare, extract + graph index, packet generation and score gating PASS in CI.
- Every extracted callsite appears in deterministic review packet with source coordinates and available graph target candidates.
- Unreviewed packet never claims any accuracy metrics.
- No production code, persisted schema, or public MCP behavior changes.
