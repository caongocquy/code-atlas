# Phase 14C — Framework & Dynamic Edges

Status: canonical design specification; implementation and implementation planning are not authorized by this document.

Base branch: `fix/cli-index-progress-ux`
Base commit: `d463d02f973819a1b3daf022d018557a955c50e3`

This specification preserves the approved Phase 14C design. Requirements below are normative; illustrative contract and relation names may follow existing CodeAtlas naming conventions without changing their meaning.

## 1. Goal

Phase 14C adds deterministic/strong framework convention recovery on top of
Phase 14B language semantics.

Architecture:

ParsedFacts
→ Phase 14B Language Semantic Graph
→ Framework Detection
→ Framework Adapter
→ FrameworkEvidence
→ Framework Resolution Gate
→ accepted FrameworkRelationship edges + FrameworkClassification records
→ diagnostics + coverage

Framework semantics must NOT be embedded into the Phase 14B resolver core.

MCP, CLI, TUI, Desktop, and agent adapters consume the same core/query APIs.
MCP remains an outer adapter and must not own framework semantics.

## 2. V1 framework scope

Support these framework families first:

- React / Next.js
- NestJS
- Spring / Spring Boot common annotations
- Flutter

Do not expand V1 to arbitrary framework ecosystems.

## 3. Framework adapter architecture

Use a typed framework adapter layer, not:
- resolver-core hardcoding
- generic rule DSL
- LLM-generated relationships

Define an explicit framework adapter contract equivalent to:

interface FrameworkSemanticAdapter {
  id: string;
  version: string;
  frameworks: FrameworkId[];

  detect(ctx: FrameworkDetectionContext): DetectionResult;

  analyze(
    facts: RepositoryFactsView,
    graph: ResolvedGraphView,
    ctx: FrameworkAnalysisContext
  ): FrameworkEvidence[];
}

Adapters must consume ParsedFacts + resolved language graph + relevant
materialized framework/config facts. All inputs, including the facts and graph
views, must be materialized candidate inputs exposed by the framework analysis
context. Adapters must not independently read package, build, or framework config
files through filesystem side channels during semantic analysis. Detection uses
materialized metadata exposed by its detection context as well.

Adapters MUST NOT:
- parse source text again
- use regex/source-text side channels
- directly materialize entities, graph edges, or classifications
- guess ambiguous targets

If framework semantics need objective information missing from ParsedFacts,
the extractor/facts contract must be intentionally extended and versioned.
Do not introduce hidden reparsing.

## 4. Framework evidence

FrameworkEvidence is an observation envelope, not an authoritative output.
It carries an explicit output discriminator: relationship or classification.
Relationship observations carry a source reference and optional unresolved target;
classification observations carry a subject reference, classification kind, and
observed value, without a target. Unresolved references/candidates remain evidence,
never accepted outputs. Reference roles may address language entities (including
files where appropriate) or FrameworkEntityRef, with explicit variant tags.
Framework-native references carry supporting entity-definition observations from
materialized facts/config, sufficient for the gate to validate scope, canonical key
and provenance. A bare reference string cannot establish an authoritative entity.

Define an explicit contract carrying at minimum:

- deterministic evidenceId
- framework id
- adapter id
- adapter version
- evidence kind
- source logical reference for relationships or subject logical reference for classifications
- optional target logical reference for relationship observations only
- source/target/subject ranges where applicable
- output discriminator and relation kind or classification kind/value
- origin = framework_inferred
- confidence = exact | strong | weak
- supporting evidence refs
- strategy
- applicability/support metadata

Framework evidence kinds should cover the approved V1 semantics, including
equivalents of:

- component_usage
- route_binding
- layout_binding
- controller_route
- module_provider
- dependency_injection
- bean_relationship
- widget_composition
- navigation_binding
- execution_boundary

Names may be normalized to fit existing CodeAtlas conventions, but meaning
must remain explicit.


### 4.1 Framework entities and identity

A framework-native entity is not a language symbol. Routes, layouts and endpoints
represented as routes use a logical contract equivalent to:

```ts
interface FrameworkEntityRef {
  framework: FrameworkId;
  kind: FrameworkEntityKind;
  logicalKey: string;
}
```

FrameworkEntityKind explicitly distinguishes route, layout, and other supported
framework-native entity kinds requiring a non-symbol identity. A language handler
remains a language entity; its route/endpoint is a distinct framework entity.
Adding a kind does not expand V1 framework scope.

Identity is repository-scoped. The tuple (framework, kind, logicalKey) must use an
unambiguous canonical serialization, not delimiter concatenation that can collide.
logicalKey includes the materialized application/router scope, entity semantics,
and canonical route/layout key. Scope is derived from repository-relative project
identity and explicit config facts, never checkout absolute paths, generation IDs,
timestamps, discovery order, or adapter version. Same inputs yield the same identity
across clean, warm and incremental runs. Monorepo applications do not share route
identities merely because their displayed paths match.

Route canonicalization is framework-specific and versioned. Normalize filesystem
separators in convention paths, then derive route segments from supported
conventions. Keep display/source spelling and ranges in evidence. Preserve case,
parameter names, parameter constraints, catch-all/optional segments and matching
conditions unless a supported framework rule proves equivalence. Do not blindly
decode percent escapes, lowercase paths, collapse slashes, remove trailing slashes,
or equate framework parameter syntaxes. Apply base prefixes and supported routing
config only from materialized candidate facts. Incomplete matching config is
unknown/unsupported rather than a guessed canonical route.

Examples within an explicit application/router scope:
- Next `app/users/page.tsx` yields route `/users`; route groups contribute no URL
  segment, while layout/slot ownership remains separately scoped. A layout uses its
  canonical convention owner/slot identity, not only its URL, so nested layouts
  sharing a route path do not collapse.
- Nest controller prefix plus handler mapping yields endpoint `GET /users/:id`.
  HTTP method is canonical uppercase and part of the endpoint key.
- Spring mapping yields endpoint `GET /users/{id}`, retaining parameter syntax
  and supported matching constraints. It is not equated with the Nest key.
- Flutter static named-route entry yields `/settings` in its route-table scope.
  Named-route strings retain exact matching semantics; do not apply web URL
  normalization to them.

Distinct methods or explicit matching conditions remain distinct. A missing method
must not default to GET; an explicitly supported all-method mapping is represented
as such. Potentially overlapping matcher identities must preserve ambiguity when
the facts cannot establish a unique destination.

Repeated evidence for the same proven entity is deduplicated and provenance merged
in canonical bounded order. Incompatible declarations claiming the same key, or
unresolved routing overlaps, produce stable collision/ambiguity diagnostics.
Do not use first/last wins, generated suffixes, or guessed edges to disambiguate.
Hash-backed storage must compare canonical tuples and never merge unequal tuples
because their hashes collide.

Add/change/delete/rename operates within candidate materialization. A source rename
preserving semantic scope/key retains entity identity and updates evidence ranges;
a route or scope rename changing the key removes the old identity and adds the new
one. No speculative rename alias is created. Deletion removes entities with no surviving support,
incident relationships and attached classifications from the new candidate, while
entities with surviving valid support remain. Recompute the proven dependent
neighborhood, broadening framework resolution when necessary.

Entities, bounded framework provenance, accepted relationships and classifications
are persisted together in the candidate and published atomically. No dangling
accepted endpoints/subjects or mixed-generation records are allowed. Failed
publication preserves the prior generation; reused records must be valid in the
new candidate. Entity provenance identifies framework, adapter/version, strategy,
categorical confidence and compact source/config evidence references. These records
follow the same read-only guarantees as the rest of framework materialization.

### 4.2 Accepted output contracts

Accepted outputs form an explicit discriminated union equivalent to:

```ts
type FrameworkAcceptedOutput =
  | FrameworkRelationship
  | FrameworkClassification;

interface FrameworkRelationship {
  outputKind: "relationship";
  source: FrameworkSubjectRef;
  target: FrameworkSubjectRef;
  relationKind: FrameworkRelationKind;
  provenance: FrameworkProvenance;
}

interface FrameworkClassification {
  outputKind: "classification";
  subject: FrameworkSubjectRef;
  classificationKind: FrameworkClassificationKind;
  classificationValue: string;
  provenance: FrameworkProvenance;
}
```

FrameworkSubjectRef is a tagged union of an existing language entity reference
(symbol or file/module as applicable) and FrameworkEntityRef. The named kind
types denote the explicit supported semantic vocabularies, not arbitrary user rules.
FrameworkProvenance is the bounded contract in section 6; accepted confidence is
exact or strong only. Classification values must belong to the supported vocabulary
for their kind, e.g. execution_boundary has client/server values.

Relationships materialize as typed graph relationships only after both endpoints
resolve uniquely. Classifications attach to their uniquely resolved subject and
require no artificial target. They must never materialize as self-edges or fake
virtual targets. Evidence may remain unresolved, but an accepted output cannot
contain unresolved references. Both paths preserve origin, confidence, strategy,
evidence, diagnostics, coverage, deterministic ordering, and the independent
frameworkResolutionVersion semantics. Entity/classification persistence layout
changes use schemaVersion where required, without repurposing facts or language
resolution versions.

## 5. Resolution gate

FrameworkEvidence
→ FrameworkResolutionGate
→ resolved | ambiguous | unknown | unsupported | budget_exhausted
→ accepted exact/strong FrameworkRelationship or FrameworkClassification only

Rules:

- relationships require uniquely identified source and target under framework
  semantics before materializing as authoritative graph edges
- classifications require a uniquely identified subject and a uniquely supported
  classification value; they materialize as records, not graph edges
- weak evidence is diagnostic only
- multiple plausible candidates => ambiguous, no authoritative edge
- missing relationship endpoint or classification subject/value => unknown,
  no guessed output
- unsupported construct => unsupported, no guessed edge
- budget exhausted => no guessed edge
- framework adapter infrastructure failure is not semantic uncertainty

All ambiguous, unknown, unsupported, weak, or budget-exhausted observations are
diagnostic only for both paths: no guessed edges or classification records.
Conflicting exclusive classification values remain ambiguous; ordering must not
select a winner. Preserve CodeAtlas unique-or-drop precision.

## 6. Provenance taxonomy

Normalize intelligence provenance for future 14D/15 use:

- extracted
  parser/objective source fact

- language_inferred
  Phase 14B resolver inference

- framework_inferred
  Phase 14C framework semantics

- derived
  graph/change/reliability computation

Framework entities and accepted relationships/classifications must persist bounded
provenance with origin = framework_inferred and at least:

- framework
- adapter id/version
- strategy
- categorical confidence
- evidence ids / compact evidence refs

Do not persist full inference traces or transient candidate queues.

The public/query layer must be able to explain:
- where the entity, relationship, or classification came from
- which framework rule/strategy produced it
- whether it was exact or strong
- which file/range evidence supports it

## 7. Version domains

Keep version domains independent.

Existing domains:
- schemaVersion
- factsSchemaVersion
- factsVersion
- parserIdentity
- resolutionVersion
- derivedVersion

Add a distinct framework semantic domain equivalent to:

frameworkResolutionVersion

Semantics:

- factsVersion:
  objective extraction semantics only

- parserIdentity:
  parser/runtime/grammar provenance only

- resolutionVersion:
  Phase 14B language resolver semantics

- frameworkResolutionVersion:
  framework adapters, entity identity/canonicalization, relationship and classification semantics

- derivedVersion:
  projections/analytics only

Changing Spring/Next/etc adapter semantics must NOT force a ParsedFacts reparse
or a full Phase 14B language resolution rebuild when inputs remain compatible.

## 8. Generation and publication

Framework materialization is part of the same candidate generation lifecycle.

Conceptually:

active generation N

candidate N+1:
  ParsedFacts
  language graph
  framework entities + relationship graph
  framework classifications
  framework diagnostics
  framework coverage

→ atomic publish

Do not publish a new language graph with stale framework materialization.

Infrastructure failure during framework analysis:
- fail candidate publication
- preserve previous active generation

Semantic uncertainty:
- may publish candidate
- reflect uncertainty in diagnostics/coverage
- do not create guessed edges

## 9. Incremental invalidation

Framework resolution must be incremental but conservative.

Framework input identity includes:
- candidate ParsedFacts generation
- candidate language graph
- relevant framework config/materialized config facts
- adapter/framework version

For ordinary source changes:
- analyze changed file
- analyze only the framework-dependent neighborhood proven necessary
- reuse unaffected framework materialization

If safe scope cannot be established:
- broaden to framework-wide or repo-wide FRAMEWORK resolution
- reuse ParsedFacts
- reuse Phase 14B graph when compatible
- do not reparse source merely because framework invalidation became broad

Framework config changes:
- scope narrowly only when correctness can be proven
- otherwise framework-wide/repo-wide framework resolution

frameworkResolutionVersion bump:
- zero source parse expected when facts compatible
- zero language semantic re-resolution expected when 14B inputs compatible
- rebuild framework layer using cached facts/language graph

Expose work counters equivalent to:
- parsedFiles
- languageResolvedFiles
- frameworkResolvedFiles
- frameworkReusedFiles

Exact names should follow existing index-report conventions.

## 10. Detection and capabilities

Framework detection must distinguish:

configured
- dependency/build/project metadata indicates framework is present

observed
- indexed source contains framework constructs

A dependency alone must not imply full semantic coverage.

Capability state should be granular by framework capability.

Example semantics:

Next.js:
- detection: observed
- app_router: full
- pages_router: not_applicable
- middleware: partial

Do not advertise a framework or capability as full unless its semantic floor
and conformance tests pass.

## 11. Coverage primitives

Phase 14C must emit primitives for Phase 14D aggregation:

- applicable
- supported
- attempted
- resolved
- ambiguous
- unknown
- unsupported
- budgetExhausted

Dimensions should include:
- framework
- capability
- file
- strategy
- output kind (relationship or classification)
- edge kind for relationships; classification kind for classifications

The absence of a framework relationship or classification is authoritative only
when the applicable capability has sufficient coverage. Both paths emit all listed
primitives; classifications do not inflate edge counts. Entity collisions contribute
ambiguity diagnostics/coverage to the affected observations.

## 12. Stable diagnostics

Use stable reason codes, not only free-form strings.

Include equivalents of:

- framework_construct_unsupported
- framework_target_ambiguous
- framework_target_unknown
- framework_budget_exhausted
- framework_config_incomplete
- framework_adapter_failed

Diagnostics do not create graph edges or classification records. Stable reason
codes must also distinguish entity identity collision, unresolved/ambiguous subjects,
and conflicting classification values; target-specific codes apply to relationship
targets, not invented classification targets.

## 13. React / Next.js semantic floor

React V1 must support:

- JSX component usage
- local/imported component resolution
- JSX member usage where language binding resolves the receiver
- wrappers/HOCs only when target remains explicit and deterministic

Next.js V1 must support:

App Router:
- page convention -> route ownership
- layout convention -> layout ownership
- route handler convention -> API/route handler ownership

Pages Router:
- pages routes -> route ownership
- pages/api -> API route ownership

Explicit boundaries:
- "use client"
- "use server"

Potential graph relations may include equivalents of:
- renders
- owns_route
- owns_layout
- handles_route

Execution boundaries are classifications, not relations:
- "use client" → subject classification `kind: execution_boundary`, `value: client`
- "use server" → subject classification `kind: execution_boundary`, `value: server`

The subject is the file/module or callable identity justified by materialized
facts and the directive's scope. Do not invent a target or self-edge. Unsupported
scope or conflicting exclusive boundary values preserve uncertainty.

Do not infer in V1:
- React runtime state propagation
- Context value flow
- arbitrary hook dependency semantics
- implicit dynamic chunk/runtime behavior
- arbitrary HOC runtime behavior
- uncertain middleware matching
- speculative server-action call edges

## 14. NestJS semantic floor

Support:

- @Controller prefix
- HTTP handler decorators such as @Get/@Post/@Put/@Patch/@Delete
- @Module metadata:
  - controllers
  - providers
  - imports
  - exports
- constructor DI when token/class is explicit
- @Inject token when unique
- provider/module ownership

Potential relations:
- owns_controller
- owns_provider
- imports_module
- exports_provider
- handles_route
- injects

Do not authoritatively resolve:
- runtime-generated dynamic modules
- provider factories with unknowable target
- ambiguous string/symbol tokens
- reflection metadata absent from facts
- runtime-only global-module behavior

## 15. Spring semantic floor

Scope is common Spring/Spring Boot annotation semantics, not all JVM frameworks.

Support:

- @RestController
- @Controller
- @RequestMapping
- @GetMapping
- @PostMapping
- @PutMapping
- equivalent standard request mappings
- @Service
- @Repository
- @Component
- constructor injection
- explicit @Autowired field/method injection
- explicit @Bean methods

Potential relations:
- handles_route
- injects
- declares_bean
- component_of

Only resolve injection authoritatively when candidate bean identity is unique.

Do not infer in V1:
- runtime conditional beans
- environment/profile dependent activation
- complex qualifier semantics without sufficient evidence
- AOP/proxy runtime calls
- generated Spring Data method behavior
- reflection/classpath behavior outside indexed source

Annotation identity alone must not fabricate call edges.

## 16. Flutter semantic floor

Support:

- widget composition from build/widget structure
- explicit Navigator.push + explicit MaterialPageRoute destination
- Navigator.pushNamed when static route table resolves uniquely
- MaterialApp static route tables
- statically analyzable GoRouter declarations when facts are sufficient
- explicit provider/state injection where target type/constructor resolves:
  - Provider
  - ChangeNotifierProvider
  - BlocProvider
  - RepositoryProvider

Potential relations:
- renders
- navigates_to
- owns_route
- provides
- consumes

Keep framework-extension rules modular internally, e.g. Flutter core vs
Provider/BLoC-specific rule groups/capabilities, rather than polluting the
language resolver.

Do not infer:
- dynamic Navigator construction
- unavailable generated router semantics
- runtime dependency lookup with insufficient type evidence
- state propagation/event behavioral flow
- Bloc event-to-handler behavior
- generated provider-family/runtime magic without explicit evidence

## 17. Confidence rules

Categorical confidence only:

exact
- direct framework convention/annotation plus unique identity

strong
- deterministic framework semantics requiring a bounded inference step with
  unique result

weak
- plausible but non-authoritative; diagnostic only

No numeric threshold conversion.
No weak authoritative edges or classifications.

Examples:
- Next app/users/page.tsx -> /users: exact
- unique Nest provider injection from deterministic module visibility:
  exact or strong according to evidence contract
- Spring interface injection with multiple beans: ambiguous
- Flutter route string with no resolvable route table: unknown

## 18. Determinism

Same generation/config/versions must produce identical normalized:

- framework detection
- evidence ids
- resolution decisions
- framework entity identities
- accepted relationships and classifications
- provenance
- diagnostics reason codes
- coverage

across:
- cold/warm
- repeated runs
- clean rebuild/incremental equivalent
- supported parallel/single execution modes

Persisted/output ordering must be deterministic.

## 19. Conformance and test matrix

Every advertised framework capability must cover at minimum:

- positive
- negative
- ambiguous
- unknown/unsupported
- provenance
- add/change/delete
- rename when applicable
- framework config change
- frameworkResolutionVersion bump
- clean rebuild == incremental
- cold == warm
- repeated run deterministic
- framework-only rebuild performs no unnecessary source parse
- framework-only rebuild performs no unnecessary language resolution

Cross-framework isolation tests:

- React repo must not be classified as Next without Next evidence
- React + Next coexist correctly
- Nest + plain TypeScript do not leak framework edges
- Spring + plain Java/Kotlin coexist
- Flutter + plain Dart coexist
- multi-framework monorepo scopes adapters correctly
- one framework adapter must not contaminate another framework's files

Additional entity/classification conformance requirements:
- stable FrameworkEntityRef tuples and route canonicalization for all four examples
- distinct application/router scopes, methods, matching constraints and layout slots
- duplicate evidence deduplication versus incompatible key collisions and overlaps
- ambiguity preserved without guessed authoritative relationships/classifications
- add/change/delete/rename, including stable-key renames and changed-key removal
- clean rebuild == incremental entity identity, provenance and query visibility
- generation publication/rollback with no dangling entity references
- inspectable bounded entity provenance and explicitly typed query results
- classification determinism across cold/warm, repeated and incremental runs
- execution boundaries produce no self-edge or artificial virtual target
- conflicting classification values remain ambiguous with diagnostics/coverage
- classifications remain inspectable by future 14D/15 consumers
- framework-only version changes rebuild entities/classifications without unnecessary
  compatible facts parsing or language resolution
- analysis consumes materialized candidate inputs without filesystem config reads

## 20. Evaluation priorities

Phase 14C optimizes precision before recall.

Evaluate representative repository fixtures with questions equivalent to:

- which controller/service handles this endpoint?
- which components does this page render?
- which screen owns this route?
- which providers does this module inject?

Track:
- accepted framework edge precision
- false-positive rate
- ambiguity preservation
- incremental equivalence
- framework-only rebuild parse count

Do not add mandatory embeddings or LLM evaluation/runtime dependencies.

## 21. Query/API behavior

Do not require new user-facing commands solely for Phase 14C.

Existing graph/intelligence/query consumers should see accepted framework edges
through the common core APIs. Framework entities are explicitly typed graph
entities, distinct from language symbols; relationships may connect these typed
entities. Classifications are inspectable subject metadata through the same core
query surface, including provenance, diagnostics and coverage. Symbol-only consumers
must preserve their symbol contract rather than coercing framework entities into
symbols. Graph traversal follows relationships, never fabricated classification
edges. Future 14D/15 consumers can inspect both output variants without re-inference.

Framework provenance must remain inspectable by future:
- query/explore
- impact
- trace
- inspect-change
- Phase 14D reliability
- Phase 15 context runtime

CLI/MCP/UI must not duplicate framework inference logic.

## 22. Read-only and safety semantics

Read-only operations must not:
- migrate schema
- rebuild framework materialization
- write cache
- change timestamps
- publish generations
- mutate Git/config/guidance

Preserve current read-only/WAL/provider/freshness guarantees from Phase 14A/14B.

## 23. Non-goals

Explicitly exclude from Phase 14C:

- generic framework rule DSL
- plugin marketplace
- arbitrary user rules
- LLM-generated graph relationships
- runtime tracing/instrumentation
- browser/app execution
- generic state/data-flow engine
- generic DI simulator
- generated-code execution
- full Spring reflection semantics
- full React runtime state semantics
- full Flutter state-management semantics
- framework-specific MCP/agent tools
- watcher/daemon work
- Phase 14D product-level reliability aggregation
- Phase 15 context runtime

## 24. Migration policy

This is an incremental extension, not a rewrite.

Preserve:
- Phase 14A ParsedFacts/cache/generation architecture
- Phase 14B TypeEnvironment/resolver semantics
- current graph/query interfaces where compatible
- existing CLI/MCP contracts
- accepted 11-test baseline waiver as historical test state only; do not
  normalize new regressions into that waiver

No package/lockfile changes unless technically required and explicitly justified.

## 25. Acceptance criteria

The spec must state exact closure expectations:

- all four framework families have defined capability floors
- accepted relationships and classifications are exact/strong only
- framework entity identity is stable, canonical, collision-safe and query-visible
- classifications are inspectable without artificial targets or self-edges
- provenance is persisted and inspectable
- ambiguity/unknown/unsupported/budget are preserved
- framework layer does not source-reparse
- framework-only version bump reuses compatible facts/language graph
- incremental result normalizes equal to clean rebuild
- cross-framework contamination tests pass
- no new regression beyond the already waived inherited baseline
- build/lint/tsc/UI/package/MCP verification remains intact
- full review has no remaining P0/P1/P2 findings


## Contract clarifications

- `FrameworkSemanticAdapter` is a design contract, not production code. Its context/view types denote read-only candidate facts, resolved language graph, and materialized configuration inputs; adapters have no edge-write authority.
- An optional target on relationship evidence permits unresolved observations. Accepted relationships require unique source and target. Classifications require a unique subject and supported value, never a target.
- `framework_adapter_failed` reports an infrastructure failure of the candidate attempt. It is not a sixth semantic resolution outcome and cannot authorize publishing a partially updated generation.
- `schemaVersion` governs persistence layout; `factsSchemaVersion` governs the serialized facts shape. Intentionally adding objective facts changes the applicable facts contract/version domains. Framework strategy changes alone change `frameworkResolutionVersion`, without changing compatible facts or language resolver versions.
- Reuse is based on compatible, unchanged dependencies within the candidate inputs. A new candidate generation alone does not require reanalyzing every framework file. Reused materialization must still be valid for the complete candidate that is atomically published.
- `configured` and `observed` describe detection evidence, not coverage levels. Coverage primitives remain scoped to applicable constructs and capability dimensions; missing, incomplete, or unsupported evidence cannot be presented as an authoritative absence.
- The Next.js capability example illustrates reporting shape, not a promise of V1 middleware resolution. Uncertain middleware matching remains outside authoritative V1 inference.
- Framework route, layout, composition, and injection relationships retain their explicit meaning. They must not be relabeled as ordinary language call edges merely to fit an existing consumer.
