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
→ accepted framework edges
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
materialized framework/config facts.

Adapters MUST NOT:
- parse source text again
- use regex/source-text side channels
- create graph edges directly
- guess ambiguous targets

If framework semantics need objective information missing from ParsedFacts,
the extractor/facts contract must be intentionally extended and versioned.
Do not introduce hidden reparsing.

## 4. Framework evidence

FrameworkEvidence is not yet an authoritative graph edge.

Define an explicit contract carrying at minimum:

- deterministic evidenceId
- framework id
- adapter id
- adapter version
- evidence kind
- source logical identity
- optional target logical identity
- source/target ranges where applicable
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

Names may be normalized to fit existing CodeAtlas conventions, but meaning
must remain explicit.

## 5. Resolution gate

FrameworkEvidence
→ FrameworkResolutionGate
→ resolved | ambiguous | unknown | unsupported | budget_exhausted
→ authoritative graph only for accepted exact/strong results

Rules:

- exact/strong may enter authoritative graph only when target identity is
  unique under the framework semantics
- weak evidence is diagnostic only
- multiple plausible candidates => ambiguous, no authoritative edge
- no supported target => unknown, no guessed edge
- unsupported construct => unsupported, no guessed edge
- budget exhausted => no guessed edge
- framework adapter infrastructure failure is not semantic uncertainty

Preserve CodeAtlas unique-or-drop precision.

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

Framework accepted edges must persist bounded provenance with at least:

- framework
- adapter id/version
- strategy
- categorical confidence
- evidence ids / compact evidence refs

Do not persist full inference traces or transient candidate queues.

The public/query layer must be able to explain:
- where the relationship came from
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
  framework adapters/framework edge semantics

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
  framework graph
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
- edge kind

The absence of a framework relationship is authoritative only when the
applicable capability has sufficient coverage.

## 12. Stable diagnostics

Use stable reason codes, not only free-form strings.

Include equivalents of:

- framework_construct_unsupported
- framework_target_ambiguous
- framework_target_unknown
- framework_budget_exhausted
- framework_config_incomplete
- framework_adapter_failed

Diagnostics do not create graph edges.

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
- client_boundary
- server_boundary

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
No weak authoritative edges.

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
- accepted edges
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
through the common core APIs.

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
- accepted edges are exact/strong only
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
- An optional target on evidence permits unresolved observations. An accepted relationship must have a uniquely identified target; absent targets never become authoritative edges.
- `framework_adapter_failed` reports an infrastructure failure of the candidate attempt. It is not a sixth semantic resolution outcome and cannot authorize publishing a partially updated generation.
- `schemaVersion` governs persistence layout; `factsSchemaVersion` governs the serialized facts shape. Intentionally adding objective facts changes the applicable facts contract/version domains. Framework strategy changes alone change `frameworkResolutionVersion`, without changing compatible facts or language resolver versions.
- Reuse is based on compatible, unchanged dependencies within the candidate inputs. A new candidate generation alone does not require reanalyzing every framework file. Reused materialization must still be valid for the complete candidate that is atomically published.
- `configured` and `observed` describe detection evidence, not coverage levels. Coverage primitives remain scoped to applicable constructs and capability dimensions; missing, incomplete, or unsupported evidence cannot be presented as an authoritative absence.
- The Next.js capability example illustrates reporting shape, not a promise of V1 middleware resolution. Uncertain middleware matching remains outside authoritative V1 inference.
- Framework route, layout, boundary, composition, and injection relationships retain their explicit meaning. They must not be relabeled as ordinary language call edges merely to fit an existing consumer.
