# Phase 14D — Reliability and Evidence Intelligence Design

Status: proposed architectural design

Base: `fix/cli-index-progress-ux` at `a24d84ea99f444fa24f3d40efd17024015cef6d0`

This document defines the reliability model that will expose the uncertainty,
provenance, diagnostics, and coverage primitives established by Phases 14A–C.
It is a design only. It does not implement Phase 14D, create implementation
plans, or start Phase 15.

## 1. Goals

Phase 14D will provide one deterministic reliability vocabulary for graph
queries, repository status, CLI output, MCP responses, and future Phase 15
consumers. It must make uncertainty visible without turning incomplete data
into negative facts, preserve evidence ownership across incremental rebuilds,
and remain compatible with existing symbol, framework, and graph contracts.

The model must distinguish:

- where an observation came from;
- how strongly the observation supports a candidate;
- whether analysis was complete;
- whether an output is authoritative for the relevant universe; and
- which diagnostics and coverage facts explain the result.

## 2. Non-goals

Phase 14D does not add context reads, a compiler, receipts, an evaluation
harness, embeddings, vector retrieval, watchers, daemons, Streamable HTTP,
generic analytics, runtime tracing, or LLM-derived confidence. It does not
expand framework capabilities. It does not make `complete` mean `correct`, or
`resolved` mean globally authoritative.

## 3. Current foundation and ownership

Phase 14A owns ParsedFacts, facts schema/version compatibility, parser identity,
and atomic candidate publication. Phase 14B owns language resolution and graph
edges, including resolution strategy, exact/strong confidence, evidence refs,
and resolution version. Phase 14C owns framework detections, framework entity
refs, relationships, classifications, provenance, diagnostics, coverage,
dependencies, and framework-resolution-version invalidation.

Phase 14D must consume these contracts. It must not move framework semantics
into the language resolver, reparse source text through a side channel, or
replace the existing authoritative-output gates.

## 4. Architectural choice

The selected approach is **C — Hybrid**.

The system will maintain a canonical normalized evidence/coverage/diagnostic
model inside the indexed candidate and derive a compact reliability projection
at public boundaries. Existing graph and framework outputs remain available;
the projection adds reliability without duplicating semantic resolution.

### Alternatives considered

**A — Unified Reliability Envelope.** Every stored and returned result would
carry the full envelope. This is uniform and convenient for Phase 15, but
increases storage, invalidation cost, MCP payload size, and compatibility risk.

**B — Separate Evidence plus independent projections.** Raw evidence would be
stored and each consumer would derive its own reliability view. This minimizes
API changes, but invites drift and duplicated aggregation rules between query,
status, CLI, and MCP.

**C — Hybrid (selected).** Canonical evidence and contribution state are
normalized once; a shared aggregator derives a boundary projection. This keeps
incremental behavior deterministic, limits MCP payloads, preserves current
APIs, and gives Phase 15 a stable reliability contract. Its cost is one
explicit aggregation/version boundary that every consumer must use.

| Concern                  | A                | B                 | C                                  |
| ------------------------ | ---------------- | ----------------- | ---------------------------------- |
| Storage cost             | high             | low/medium        | medium                             |
| API stability            | highest risk     | best locally      | controlled additive change         |
| Incremental invalidation | broad            | consumer-specific | contribution-owned                 |
| MCP payload              | large            | small             | compact summary plus opt-in detail |
| Query ergonomics         | simple but heavy | inconsistent      | consistent projection              |
| Phase 15 compatibility   | strong           | variable          | strong                             |
| Duplication risk         | low              | high              | low                                |

## 5. EvidenceOrigin

The public origin enum is:

```ts
type EvidenceOrigin =
  | "extracted"
  | "language_inferred"
  | "framework_inferred"
  | "derived";
```

`extracted` is directly observed by a parser or objective input extractor.
`language_inferred` is produced by the language resolver from ParsedFacts.
`framework_inferred` is produced by a framework adapter from materialized
candidate inputs. `derived` is calculated from accepted evidence and never
pretends to be an independent observation.

Origin is provenance, not confidence. An exact framework inference is still
framework-inferred, and a derived projection is never upgraded to extracted.

## 6. EvidenceRef

The compact reference is the stable pointer to the input that supports an
observation:

```ts
interface EvidenceRef {
  origin: EvidenceOrigin;
  sourcePath?: string; // canonical repository-relative path
  inputKey: string; // candidate input identity
  localId?: string; // parser/fact/adapter-local stable id
  range?: SourceRangeFact;
  ownerKey: string; // semantic contribution owner
}
```

`sourcePath` is repository-relative and canonicalized at the owning boundary;
it must not contain an absolute checkout path. `inputKey`, `localId`, and range
are descriptive evidence coordinates, not semantic entity identity. Evidence
refs are sorted and deduplicated by their canonical tuple. Generation IDs,
timestamps, traversal order, and array position never enter identity.

## 7. Evidence ownership

Every evidence contribution has a deterministic ownership key composed of the
semantic output identity and the source/input owner. The owner is the smallest
unit that can be invalidated safely: normally a canonical source path plus the
adapter capability/input key, or a configuration/dependency owner when the
observation is not source-owned.

Semantic identity remains separate:

- language symbols use their existing language identity;
- framework entities use `framework + kind + logicalKey`;
- relationships use canonical source, target, and relation kind;
- classifications use canonical subject, classification kind, and value.

Ownership is used for invalidation and evidence merging only. It must never be
appended to a semantic key to make a collision disappear.

## 8. Normalization and merge/conflict rules

The shared normalizer sorts evidence, refs, diagnostics, coverage dimensions,
and output identities by canonical keys. It removes exact duplicate
contributions and is idempotent.

Compatible evidence for the same output may merge when it agrees on semantic
identity, output kind, relation/classification semantics, and accepted
resolution. The merged result retains all distinct refs, origins, strategies,
and diagnostics in deterministic order.

Conflicting authoritative evidence never uses first-wins or last-wins. A
conflict becomes an explicit ambiguity/conflict state with stable diagnostic
code and evidence refs. It cannot be counted as resolved or emitted as a
guessed relationship/classification.

Removing one owner removes only that owner’s contribution. The output remains
accepted only if the remaining contributions independently satisfy the normal
resolution gate.

## 9. Reliability outcome and orthogonal conditions

Reliability separates the semantic outcome of analysis from completeness and
freshness. These dimensions are related, but they are not interchangeable and
must not be collapsed into one enum.

```ts
type ReliabilityOutcome =
  | "accepted"
  | "ambiguous"
  | "unknown"
  | "unsupported"
  | "budget_exhausted";
```

`accepted` means the normal exact/strong gate passed for the represented
output. It does not imply the entire repository or relevant universe is
complete or current. A reused output may therefore remain `accepted` while
`stale: true` or `complete: false`.

`stale` is an orthogonal freshness condition. `complete` is an orthogonal
analysis-universe condition. Neither changes the semantic outcome by itself,
and neither may be inferred from the outcome name.

There is no generic float confidence in this design. Existing bounded
confidence values such as exact/strong/weak remain strategy-specific gates;
they are not converted into percentages or globally comparable scores.

## 10. Completeness

Completeness describes whether all relevant work and inputs needed for a
reliable negative or aggregate claim were analyzed. It is not a correctness
proof.

The aggregate is incomplete when relevant adapter/config input fails, budget is
exhausted, relevant evidence is unknown or unsupported, a reused contribution
originated in an incomplete materialization, or framework resolution is stale.
Successful recomputation may recover completeness only after every relevant
contribution is recomputed or independently known complete.

Cold diagnostic-only materialization must preserve incomplete state when it
cannot establish the relevant universe. Reusing a prior output cannot upgrade
that state by itself.

## 11. Authority and relevant-universe scope

Authority answers whether a consumer may treat the result as a reliable answer
for one explicitly identified relevant universe. An accepted
edge/entity/classification may be authoritative for that output while a broader
repository aggregate remains incomplete.

Every authority decision therefore requires a canonical scope. The scope is
semantic/query identity, not checkout identity, and must be stable across
worktrees and incremental generations.

```ts
interface ReliabilityScope {
  scopeKey: string; // canonical identity of the relevant universe
  capability: string;
  outputKind?: string;
  framework?: string;
  language?: string;
  selectorKey?: string; // canonical query/subject selector when applicable
}

interface EvidenceSummary {
  total: number;
  origins: readonly EvidenceOrigin[];
}

interface ReliabilityDetail {
  evidence?: readonly EvidenceRef[];
  diagnostics?: readonly DiagnosticRef[];
  detailTruncated: boolean;
  evidenceReturned?: number;
  evidenceTotal?: number;
  diagnosticsReturned?: number;
  diagnosticsTotal?: number;
}

interface ReliabilityProjection {
  scope: ReliabilityScope;
  outcome: ReliabilityOutcome;
  complete: boolean;
  stale: boolean;
  authoritative: boolean;
  authoritativeNegative: boolean;
  coverage: CoverageSummary;
  diagnosticCodes: readonly string[];
  evidenceSummary: EvidenceSummary;
  detail?: ReliabilityDetail;
}
```

The aggregator owns construction and canonicalization of `ReliabilityScope`.
Consumers may supply a query selector, but they may not invent independent
authority semantics. Repository status, graph queries, framework queries, CLI,
and MCP all call the same aggregator with a canonical relevant-universe scope.

No field may infer another field by name alone. In particular, `complete` does
not imply `authoritative`, `stale: false` does not imply complete, and
`outcome: "accepted"` does not imply repository-wide authority.

## 12. Authoritative-negative rule

Absence is authoritative only when the canonical `ReliabilityScope` for the
request is known complete, current, and fully supported for the requested
capability. If materialization is incomplete or stale, or the scoped outcome is
ambiguous, unknown, unsupported, or budget-exhausted, absence is uncertainty—not
a negative fact.

`authoritativeNegative` is therefore meaningful only together with its scope.
A `true` value for one capability/selector universe must never be reused as a
negative claim for another universe.

Query, status, CLI, and MCP must expose `authoritativeNegative: false` together
with the relevant outcome, completeness, freshness, diagnostics, and scope. No
downstream projection may turn an incomplete result into “not present”.

## 13. Coverage model

Coverage remains dimensional and output-kind-aware. The canonical counters are:

`applicable`, `supported`, `attempted`, `resolved`, `ambiguous`,
`unknown`, `unsupported`, `budgetExhausted`.

For each normalized dimension, terminal outcomes are mutually exclusive. A
conflicted or ambiguous candidate is never also resolved. `resolved` counts
accepted outputs only; it does not count configured frameworks, observed
constructs, or merely attempted work.

Configured presence, observed constructs, and supported capabilities are
separate signals. Configuration alone cannot create applicable/resolved
coverage. Unsupported constructs remain visible as unsupported/incomplete.

Reused and recomputed contributions are unioned by ownership key before
counting, so no contribution is double-counted.

## 14. Diagnostics

The canonical diagnostic set includes:

- `framework_construct_unsupported`
- `framework_target_ambiguous`
- `framework_target_unknown`
- `framework_budget_exhausted`
- `framework_config_incomplete`
- `framework_adapter_failed`
- `framework_entity_identity_collision`
- `framework_subject_ambiguous`
- `framework_subject_unknown`
- `framework_classification_conflict`

Each diagnostic carries canonical framework/capability/path/strategy identity,
stable outcome, deterministic evidence refs, and a reason. Diagnostics are
contributions owned by the evidence that caused them. Recomputed ownership
removes resolved-away diagnostics; unrelated reused diagnostics survive.

Diagnostics are explanatory state, not accepted graph outputs. A diagnostic
must not manufacture a target, self-edge, or classification.

## 15. Stale and incomplete propagation

Every aggregate consumer receives stale/incomplete state from the same
reliability aggregator. A framework-resolution-version mismatch is stale even
when ParsedFacts and the language graph are reusable. Reused incomplete state
remains incomplete until its owning relevant paths are successfully recomputed.

Stale outputs may be displayed as historical/reused evidence, but cannot make
new negative claims authoritative. When an owning path is recomputed and its
old output disappears, the old output and its diagnostics/coverage contribution
are removed atomically.

## 16. Incremental computation

The canonical input contract distinguishes:

- `allMaterializedPaths`: all paths represented by the candidate;
- `analysisPaths`: paths requiring framework analysis/re-analysis;
- `deletedPaths`: paths no longer present;
- `dependencyAffectedPaths`: paths expanded through materialized dependencies.

The next candidate is normalized as:

```text
reused contributions from unaffected owners
+ recomputed contributions owned by analysisPaths
- prior contributions owned by analysisPaths or deletedPaths
```

All merge, conflict, diagnostics, coverage, and completeness rules then run on
the normalized union. A framework-only version bump may broaden framework
recomputation without reparsing facts or rerunning compatible Phase14B
resolution.

The normalized reliability result for an incremental rebuild must equal the
result of a clean full rebuild over the same inputs.

## 17. Storage and versioning

The preferred storage split is:

- **stored:** source-owned normalized evidence refs, output contributions,
  diagnostics, coverage contributions, framework/language version domains,
  and completeness-relevant ownership state;
- **derived:** aggregate reliability state, authority, authoritative-negative
  decision, and compact query/status summaries;
- **partial:** bounded evidence detail in public responses, with opt-in detail
  where existing APIs support it.

Do not persist a second independently mutable reliability truth. If schema
changes are required, use an explicit reliability schema/version domain
separate from facts schema, parser identity, language resolution version, and
framework resolution version. Existing generations remain readable or are
marked stale; they are never silently interpreted under a new meaning.

## 18. Query projection

Query services retain symbol-only compatibility while exposing typed framework
entities and reliability metadata. A result may include a language node,
framework entity, relationship, classification, or diagnostic state without
coercing one into another.

The projection must preserve subject/target identity, canonical reliability
scope, outcome, completeness, freshness, coverage, and authority. Detailed
evidence refs are optional/bounded detail rather than mandatory payload.
Classification results have no artificial target and are never self-edges.
Symbol-only consumers receive the existing projection unless they explicitly
request framework/reliability detail.

## 19. CLI and repository status

CLI/status output will summarize configured, observed, supported, complete,
stale, and authoritative-negative state separately for an explicit canonical
reliability scope. It must not report “no results” as a definitive negative
when the relevant reliability projection is incomplete or stale.

Human output may compact diagnostics; JSON output must retain the canonical
scope key, stable diagnostic codes, outcome, completeness, freshness, authority,
and coverage fields. TTY formatting must not change the underlying deterministic
values.

## 20. MCP wire contract

MCP responses add an optional compact reliability projection. Existing result
fields remain backward compatible. The default response includes canonical
scope identity, outcome, complete, stale, authoritative, authoritativeNegative,
summary coverage, evidence summary, and stable diagnostic codes. Full evidence
refs and full diagnostics are opt-in or bounded detail.

Response-detail truncation is transport metadata only. It sets
`detailTruncated` and returned/total counts when detail is requested; it must not
change `outcome`, `complete`, `stale`, `authoritative`, or
`authoritativeNegative`.

MCP serialization uses sorted arrays and stable keys. It never emits a guessed
negative merely because an empty result array was returned. Initialize and
rejection/error paths remain compatible with current MCP behavior.

## 21. Backward compatibility

Existing graph edges, framework relationships/classifications, status fields,
and MCP result fields remain readable. New reliability fields are additive
until a separately approved breaking version is needed. Existing exact/strong
resolution semantics remain authoritative gates; Phase 14D only exposes their
meaning consistently.

Read-only operations must remain side-effect free: query/status/MCP reads must
not create WAL/SHM files, mutate generations, or publish candidates.

## 22. Performance and budget

Evidence refs are compact, deduplicated, and source-owned. Aggregation should
operate on normalized contributions rather than rescanning source text.

Two budget classes are distinct and must never be conflated:

- **analysis budget:** limits semantic analysis/resolution work. Exhausting this
  budget produces `outcome: "budget_exhausted"` and propagates incomplete
  semantics where the relevant universe cannot be established;
- **response-detail budget:** limits how many evidence/diagnostic details are
  serialized to a consumer. Exhausting this budget only sets detail-truncation
  metadata and returned/total counts. It never changes reliability semantics.

Public responses use deterministic detail truncation. The compact projection
(evidence summary, diagnostic codes, outcome, completeness, freshness,
authority, coverage, and scope) must remain available even when detail is
truncated.

No performance optimization may drop the summary information needed to explain
an ambiguous, unknown, unsupported, stale, or incomplete result. Reuse must not
trade away correctness for fewer adapter calls.

## 23. Phase 15 compatibility

Phase 15 may consume reliability projections and evidence refs as inputs to
future context/receipt workflows, but Phase 14D does not implement those
features. The contract must therefore remain checkout-independent,
deterministic, typed, and explicit about authority. Phase 15 must not need to
reconstruct provenance from human CLI text or infer uncertainty from empty
arrays.

## 24. Conformance matrix

| Area              | Required conformance                                                                                                          |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Origin            | Every evidence item has one of the four `EvidenceOrigin` values                                                               |
| Identity          | Entity/output keys exclude checkout path, generation, and traversal order                                                     |
| Reliability scope | Scope keys are canonical, checkout-independent, and specific to the relevant capability/query universe                        |
| Ownership         | Recompute/delete removes only owned contributions                                                                             |
| Merge             | Compatible evidence merges; conflicts become deterministic ambiguity                                                          |
| Coverage          | Terminal buckets are mutually consistent; conflict is not resolved                                                            |
| Completeness      | Adapter failure, budget, unknown, unsupported, stale reuse propagate                                                          |
| Scope/Authority   | Every authority decision has a canonical relevant-universe scope; incomplete scoped universe disables authoritative negatives |
| Incremental       | Normalized incremental result equals clean rebuild                                                                            |
| Diagnostics       | Stable, deduplicated, and removed after owner recomputation fixes issue                                                       |
| Query             | Framework entities are typed; classifications have no fake target                                                             |
| Status            | Configured, observed, supported, outcome, complete, and stale remain distinct                                                 |
| MCP               | Additive compact scoped projection, stable serialization, bounded optional detail, no guessed negatives                       |
| Read-only         | Queries/status/MCP do not write WAL/SHM or publish state                                                                      |
| Budget            | Analysis-budget exhaustion affects reliability; response-detail truncation does not                                           |

## 25. Acceptance criteria

Phase 14D design is ready for implementation only when the approved plan can
demonstrate:

1. deterministic normalized evidence and provenance across clean and
   incremental builds;
2. no first/last-wins behavior for conflicting authoritative evidence;
3. no double counting across reused and recomputed contributions;
4. correct deletion, rename, dependency expansion, and framework-version
   invalidation;
5. coverage and diagnostics that agree with reliability outcome, completeness,
   and freshness;
6. authoritative-negative safety under every incomplete/stale condition and a
   canonical relevant-universe scope for every authority decision;
7. backward-compatible query, CLI/status, and MCP projections;
8. read-only operations with no WAL/SHM side effects;
9. conformance tests for every row in the matrix; and
10. no new framework feature scope hidden inside reliability work.

## 26. Open questions for implementation planning

- Which existing AtlasStore contribution tables can carry ownership without a
  migration, and which require a reliability schema version?
- Should bounded reliability detail be requested by an explicit query/MCP option
  or selected by an existing response-detail budget? Either choice must use the
  same `ReliabilityDetail` truncation metadata and must not alter reliability
  semantics.
- Which existing language resolver diagnostic fields can be normalized directly
  to `EvidenceRef` without changing Phase14B storage?
- What is the smallest additive JSON shape that preserves current MCP clients
  while carrying the canonical scope identity and compact projection?
- Which existing query/status callers already expose enough selector/capability
  information to construct the canonical `ReliabilityScope` without breaking
  their public API? The requirement for a scope is settled by this design; only
  caller mapping is deferred to planning.

These questions are intentionally deferred to the implementation plan. No
production behavior is changed by this document.
