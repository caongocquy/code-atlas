# CA-02 — Source-backed unknown-call triage (p-queue)

## Scope and controls

Pinned project: [sindresorhus/p-queue](https://github.com/sindresorhus/p-queue/tree/7f272ab5ff2254c0dc2537b7977e88ede1cd55e8) at commit `7f272ab5ff2254c0dc2537b7977e88ede1cd55e8`.

This audit hand-picks eight **source-readable examples** as a diagnostic sample, *not* an independently sampled, adjudicated repository-scale benchmark. The implementation author has traced source definitions and invocation sites; a separate reviewer must confirm and sign off labels before any acceptance metrics.

| Case | Source anchor | Candidate target | Source-based interpretation |
| --- | --- | --- | --- |
| Imported function | `source/priority-queue.ts:88` | `source/lower-bound.ts:3 lowerBound` | Default import on priority-queue.ts:2 |
| Instance method | `source/priority-queue.ts:104` | `PriorityQueue.enqueue` defined at :58 | `this` of PriorityQueue |
| Private method | `source/priority-queue.ts:93` | `PriorityQueue.#findIndex` at :29 | Same class |
| Private method | `source/priority-queue.ts:52` | `PriorityQueue.#compact` at :18 | Same class |
| Private method | `source/priority-queue.ts:114` | `PriorityQueue.#removeFirst` at :40 | Same class |
| Local arrow | `source/index.ts:60` | `validateLimit` at :53 | Value-bound callable; graph may encode a variable rather than function node |
| Built-in | `source/lower-bound.ts:8` | No in-repo target | `Math.trunc` standard JS built-in |
| Dynamic callback | `source/lower-bound.ts:11` | No statically unique target | `comparator` is a parameter, passed by caller |

The CI tool `eval/ca02/triage-realworld-source.ts` enforces the source anchors against the immutable pinned commit, extracts each callsite with the project's real parser, and records whether a qualified target is represented as a graph node and a provenance-matched edge is published. It deliberately does not assert that all these relationships are currently resolved and does not modify the resolver. A missing node is an **extraction/representation gap**, a present node with no link is a **resolution gap**, and a callable variable needs dedicated symbol/binding evidence before promoting it to a `calls` edge.

## Acceptance boundary

- Evidence report and raw review packet are produced in CI; `accuracy = null`, review status `author_source_review_only`.
- External and dynamic cases are **not** naively counted as false negatives.
- Follow-up after external review: independently validate source symbol owner, parser fact and existing edge, add minimal red regression for each verified in-scope miss, then propose narrowly scoped production fixes without name-only fallbacks.
- Full corpus 4,099 parsed callsites / 4,098 unresolved are not automatically bugs; results must be interpreted using internal/external/dynamic class and parser capabilities.
- This PR is diagnostic-only, not a CA-02 closure or a waiver of G2/G3/D16.

## Exact-head CI evidence (2026-11-12)

- Implementation HEAD: `e7f53981a01bc0b68ef97f049291413943f0eea7`.
- [Real-world source triage CI #43248250240](https://github.com/caongocquy/code-atlas/actions/runs/43248250240): **SUCCESS** after correcting a YAML shell line-continuation issue in the initial run. Typecheck, parser runtime, 3/3 scorer tests, pinned repository index and artifact upload all PASS.
- [Phase14B #43248250445](https://github.com/caongocquy/code-atlas/actions/runs/43248250445): SUCCESS.
- [Phase15D #43248250374](https://github.com/caongocquy/code-atlas/actions/runs/43248250374): SUCCESS.
- Source-anchored triage result: **8/8** selected source calls recognized in parser; **6 internal candidates**, **1 external builtin**, **1 dynamic callback**. Of the six internal candidates, **5/6 target nodes represented** in the published graph and **1/6 with a source-line-matched published calls edge**. These are diagnostic counts for an author-curated sample; **not** independent source-level precision or recall.
- Both a **target-symbol representation gap** (at least one candidate) and a **candidate-to-edge gap** (at least four source candidates with a graph node but no matching call edge) are observable; per-case attribution/identity and reasons require review before selecting a production fix.
- Artifact `ca02-pqueue-review-packet` contains `artifacts/ca02-p-queue-source-triage.json` plus the existing 160-site review sample, full census and pending-score evidence.
- **Review status:** author source checks only, independent reviewer absent, accuracy metrics null. No automatic rewrite or name-only matching.
