# Phase 14B Multi-Language Resolver & TypeEnvironment v2 Design

**Date:** 2026-09-07  
**Status:** Design approved in conversation; ready for repository review  
**Phase:** 14B  
**Depends on:** Phase 14A ParsedFacts / Index / Cache / Invalidation v2

## 1. Summary

Phase 14B introduces a multi-language semantic resolution layer between `ParsedFacts` and the persisted resolved graph.

```text
SourceSnapshot
    ↓
ParsedFacts
    ↓
LanguageSemanticAdapter
    ↓
SemanticEvidence
    ↓
TypeEnvironment
    ↓
Resolver Strategy Pipeline
    ↓
ResolutionDecision
    ↓
ResolvedGraph + ResolutionDiagnostics
```

The core resolver is language-agnostic. Language adapters normalize parser facts into a shared semantic vocabulary. The shared resolver consumes that evidence and applies bounded, deterministic strategies.

Target languages:

```text
JavaScript
TypeScript
Python
Java
Kotlin
Go
Rust
Swift
Dart
C
C++
```

Support depth is intentionally not identical across languages.

> CodeAtlas may omit an edge when evidence is insufficient, but it must not manufacture an authoritative edge from ambiguity or weak name-only evidence.

## 2. Goals

Phase 14B must:

1. Introduce a generic `TypeEnvironment` suitable for multi-language resolution.
2. Introduce a strategy-based resolver pipeline with explicit provenance.
3. Support eleven languages through shared semantic contracts and adapters.
4. Preserve ambiguity, unsupported constructs, unknown state, and budget exhaustion as first-class outcomes.
5. Improve receiver/member resolution, constructor inference, assignment propagation, parameter/return propagation, aliases, inheritance, interfaces, traits, and chained calls where applicable.
6. Preserve Phase 14A generation isolation and atomic publication.
7. Reuse cached `ParsedFacts` without reparsing importers during resolution-only invalidation.
8. Keep resolver semantics deterministic across repeated, warm-cache, cold-cache, and parallel execution.
9. Produce coverage/diagnostic primitives sufficient for Phase 14D.
10. Preserve Phase 13 change-intelligence and Phase 14A read-only/cache/generation behavior.

## 3. Non-goals

Phase 14B does not implement:

- React/Next/Nest framework semantics
- Spring annotations or DI
- Django/FastAPI framework semantics
- Flutter framework graph semantics
- generic framework plugin expansion
- compiler-grade C++ template/ADL/SFINAE/concepts semantics
- preprocessor semantic expansion
- Rust borrow checking
- TypeScript compiler parity
- Python runtime execution
- required LSP/compiler dependencies
- embeddings
- internal LLM resolution
- semantic invalidation optimizations that suppress importer resolution
- `context(task)`
- context-aware reads
- watcher/daemon work
- repository memory
- persistent TypeEnvironment storage

Framework/runtime convention work belongs to Phase 14C. Context Intelligence belongs to Phase 15.

## 4. Architectural invariants

### 4.1 ParsedFacts remain objective source facts

```text
ParsedFacts = what the source objectively contains
```

Parsed facts may contain symbols, scopes, imports, exports, references, call sites, binding seeds, explicit annotations, declarations, parser diagnostics, and syntax-derived seeds required by language adapters.

Parsed facts must not contain chosen resolved targets, resolver confidence, resolver strategy conclusions, candidate-ranking decisions, or speculative cross-file targets.

### 4.2 SemanticEvidence is normalized but not resolved

```text
SemanticEvidence = language-specific source facts normalized into a shared vocabulary
```

Adapters may state:

```text
binding service has explicit type AuthService
call site has receiver service and member refresh
class Foo implements interface Bar
function factory has declared return type Service
```

Adapters must not choose the final graph target.

### 4.3 TypeEnvironment is transient inference state

```text
TypeEnvironment = what bindings/types/members are inferable for one candidate generation
```

It is generation-scoped, transient, and must not leak mutable state across generations.

### 4.4 ResolutionDecision preserves uncertainty

Resolver outcomes:

```text
resolved
ambiguous
unknown
unsupported
budget_exhausted
```

`unknown`, `unsupported`, and `budget_exhausted` are not equivalent to "no dependency exists."

### 4.5 ResolvedGraph contains accepted conclusions only

Weak/name-only candidates must not become authoritative graph edges.

### 4.6 No duplicate parsing

Language adapters consume `ParsedFacts`. They must not call Tree-sitter or another parser as a side channel.

If Phase 14B needs additional syntax-derived information, update the extractor contract and version facts intentionally.

### 4.7 Graph ready does not imply graph complete

A successfully published graph may still be incomplete. Negative evidence is authoritative only when relevant coverage permits it.

## 5. Language adapter model

Approximately eight adapter families cover eleven languages:

```text
ECMAScript family
├── JavaScript
└── TypeScript

Python family
└── Python

JVM family
├── Java
└── Kotlin

Go family
└── Go

Rust family
└── Rust

Swift family
└── Swift

Dart family
└── Dart

C family
├── C
└── C++
```

Sharing a family means shared normalization helpers/capabilities where semantics overlap, not forced identical handling.

Conceptual adapter contract:

```ts
interface LanguageSemanticAdapter {
  readonly languages: readonly LanguageId[];

  capabilities(language: LanguageId): SemanticCapabilities;

  normalizeFile(
    facts: ParsedFacts,
    context: AdapterContext,
  ): SemanticEvidenceBatch;
}
```

Adapters are responsible for:
- understanding language-specific fact shapes
- normalizing them into common semantic evidence
- reporting unsupported/degraded constructs
- exposing truthful capability levels

Adapters are not responsible for:
- selecting final graph targets
- creating authoritative call edges
- choosing one candidate from ambiguity
- unbounded propagation
- hiding unsupported semantics

## 6. Shared semantic evidence vocabulary

Conceptually:

```ts
type SemanticEvidence =
  | BindingEvidence
  | ImportEvidence
  | ExportEvidence
  | TypeAnnotationEvidence
  | ConstructorEvidence
  | AssignmentEvidence
  | ParameterEvidence
  | ReturnEvidence
  | MemberEvidence
  | InheritanceEvidence
  | ImplementationEvidence
  | AliasEvidence
  | ModuleEvidence
  | CallEvidence;
```

A batch may contain:

```ts
interface SemanticEvidenceBatch {
  bindings: BindingEvidence[];
  imports: ImportEvidence[];
  exports: ExportEvidence[];
  typeAnnotations: TypeAnnotationEvidence[];
  constructors: ConstructorEvidence[];
  assignments: AssignmentEvidence[];
  parameters: ParameterEvidence[];
  returns: ReturnEvidence[];
  members: MemberEvidence[];
  inheritance: InheritanceEvidence[];
  implementations: ImplementationEvidence[];
  aliases: AliasEvidence[];
  modules: ModuleEvidence[];
  calls: CallEvidence[];
  diagnostics: AdapterDiagnostic[];
}
```

Exact production names may differ, but the semantic separation must remain.

## 7. Type representation

A type cannot be represented only as a string.

Conceptually:

```ts
type TypeRef =
  | { kind: "known"; symbolId: SymbolId }
  | { kind: "named"; name: string; module?: string }
  | { kind: "union"; members: TypeRef[] }
  | { kind: "unknown"; reason: UnknownReason };
```

The resolver must not collapse a union into one target without structural evidence.

## 8. TypeEnvironment

`TypeEnvironment` is not a compiler or full type checker.

Its purpose:

> Maintain enough bounded semantic information to resolve graph relationships conservatively.

Conceptual API:

```ts
interface TypeEnvironment {
  lookupBinding(scope: ScopeId, name: string): BindingResult;
  inferType(expression: ExpressionIdentity): TypeResult;
  resolveMember(receiverType: TypeRef, member: string): MemberResult;
  resolveReturn(callable: SymbolIdentity): TypeResult;
  resolveInheritance(type: TypeRef): TypeRelationResult;
  resolveImport(reference: ImportIdentity): SymbolResult;
}
```

The environment may maintain:
- lexical bindings
- scope hierarchy
- import/export bindings
- parameter types
- return types
- constructor-instance evidence
- assignments
- aliases
- member ownership
- inheritance/interface/trait relations
- bounded return propagation
- memoized expression/member inference

It does not perform compiler-grade generic solving, runtime execution, open-ended fixed-point inference, or framework-specific DI.

## 9. Resolution decisions

Conceptually:

```ts
type ResolutionDecision =
  | ResolvedDecision
  | AmbiguousDecision
  | UnknownDecision
  | UnsupportedDecision
  | BudgetExhaustedDecision;
```

Examples:

```json
{
  "status": "resolved",
  "target": "AuthService.refresh",
  "strategy": "receiver-type-member",
  "confidence": "exact"
}
```

```json
{
  "status": "ambiguous",
  "candidates": [
    "AuthService.refresh",
    "MockAuthService.refresh"
  ],
  "reason": "union_receiver"
}
```

```json
{
  "status": "unknown",
  "reason": "receiver_type_unknown"
}
```

```json
{
  "status": "unsupported",
  "reason": "cpp_template_instantiation_required"
}
```

```json
{
  "status": "budget_exhausted",
  "reason": "candidate_expansion_limit"
}
```

## 10. Confidence model

Use categorical confidence:

```text
exact
strong
weak
```

### Exact
Structurally deterministic evidence supports one target.

### Strong
A structurally supported inference chain supports one target.

### Weak
Evidence is insufficiently structural, such as name similarity or unknown receiver matching.

Weak evidence may be diagnostic but must not produce an authoritative edge.

Do not use arbitrary uncalibrated floating-point confidence.

## 11. Unique-target gate

Rules:

```text
one exact target
→ resolved

one strong target
→ resolved

multiple plausible targets
→ ambiguous

only weak candidates
→ unknown/drop

zero candidates
→ unknown

work budget exhausted
→ budget_exhausted
```

There is no "best guess target" fallback.

## 12. Resolver strategy pipeline

Conceptually:

```text
01 lexical/local scope
02 imports/exports/modules
03 explicit type annotations
04 constructor-instance inference
05 assignment propagation
06 parameter propagation
07 return propagation
08 alias resolution
09 inheritance/interface/trait relations
10 receiver/member resolution
11 chained-call propagation
12 bounded interprocedural propagation
13 unique-target gate
```

Language capability profiles determine which strategies are applicable.

## 13. Deterministic work budgets

Resolver semantics must not depend on wall-clock time.

Use operation budgets such as:

```text
maxCandidateExpansions
maxBindingHops
maxReturnPropagationDepth
maxInheritanceDepth
maxMemberCandidates
maxExpressionNodes
maxPropagationRounds
```

When exhausted:

```text
status = budget_exhausted
```

Wall-clock performance may be benchmarked separately but must not define graph semantics.

## 14. Memoization

Memoization identity must include enough semantic state, including candidate generation, `resolutionVersion`, language, and expression/member identity.

Stable outcomes may be authoritatively memoized where safe:

```text
resolved
ambiguous
stable unknown
```

Degraded outcomes such as infrastructure failure, incomplete dependency state, or budget exhaustion must not become authoritative semantic truth.

Warm and cold memo execution must produce the same normalized graph.

## 15. Persistence boundary

Persist:

```text
ParsedFacts
ResolvedGraph
accepted edge strategy
accepted edge confidence
compact edge provenance
compact resolution diagnostics/aggregate summaries
generation metadata
```

Transient:

```text
TypeEnvironment
candidate sets
strategy queues
full strategy traces
expression inference cache
negative memo
temporary propagation state
```

A `resolutionVersion` bump must reuse compatible `ParsedFacts`, rebuild the environment, and rebuild the graph without reparsing source.

## 16. Edge provenance

Accepted semantic edges must carry enough provenance to explain why they exist.

Conceptually:

```json
{
  "from": "AuthInterceptor.handle",
  "to": "AuthService.refresh",
  "kind": "calls",
  "resolution": {
    "strategy": "receiver-type-member",
    "confidence": "strong",
    "evidence": [
      "constructor:service->AuthService",
      "member:AuthService.refresh"
    ],
    "resolutionVersion": 3
  }
}
```

Persisted storage may use compact IDs.

The model must support:
- why the edge exists
- which strategy resolved it
- whether it was exact/strong
- which adapter/evidence supported it

## 17. Capability profiles

Conceptually:

```ts
interface SemanticCapabilities {
  localBindings: SupportLevel;
  modules: SupportLevel;
  explicitTypes: SupportLevel;
  constructors: SupportLevel;
  assignments: SupportLevel;
  parameters: SupportLevel;
  returns: SupportLevel;
  members: SupportLevel;
  inheritance: SupportLevel;
  interfaces: SupportLevel;
  aliases: SupportLevel;
  dynamicDispatch: SupportLevel;
}
```

```ts
type SupportLevel =
  | "full"
  | "partial"
  | "unsupported"
  | "not-applicable";
```

Do not reduce language support to one boolean.

## 18. Language-specific target semantics

### JavaScript / TypeScript

Shared:
- modules/imports/exports
- lexical bindings
- functions/classes
- constructors
- assignments
- parameters/returns
- member access
- receiver/member calls
- aliases

TypeScript additionally:
- explicit types
- interfaces
- `implements`
- type aliases
- generic references where statically useful without compiler-grade solving

Target depth: deep.

### Python

Support:
- imports/modules
- functions/classes
- local assignments
- constructor inference
- `self` member ownership
- annotations
- aliases
- parameter/return annotations
- direct propagation

Dynamic receiver without structural evidence remains `unknown`.

Target depth: conservative/strong.

### Java / Kotlin

Shared:
- packages/imports
- classes/interfaces
- inheritance
- implementations
- constructor types
- parameter/return types
- receiver/member semantics
- fields

Kotlin normalization also covers relevant nullable forms, `object`, `companion object`, extension functions, `typealias`, and primary constructors.

Target depth: deep.

### Go

Support:
- packages/imports
- named/pointer types
- receiver methods
- interfaces
- parameter/return types
- assignments
- structural interface implementations

Multiple possible interface implementations remain ambiguous unless narrowed.

Target depth: deep.

### Rust

Support:
- modules/use
- structs/enums
- impl blocks
- traits/trait implementations
- associated functions
- methods
- let bindings
- explicit/return types
- aliases

Trait/generic dispatch that cannot be narrowed remains ambiguous/unknown.

Target depth: strong.

### Swift

Support:
- imports
- classes/structs/enums
- protocols
- extensions
- inheritance
- type annotations
- initializers
- methods
- parameter/return types

Extension members normalize to the extended owner.

Target depth: strong.

### Dart

Support:
- imports
- classes/constructors
- extends/implements
- mixins
- extensions
- parameter/return/field types
- receivers
- assignments

Flutter-specific semantics are excluded.

Target depth: strong.

### C

Support:
- functions/direct calls
- variables
- typedefs
- structs
- includes
- function pointers when statically obvious
- direct aliases/assignments

OO-specific capabilities are not applicable.

Target depth: structural/strong where static.

### C++

Conservative support:
- namespaces
- classes/structs
- methods/constructors
- explicit inheritance
- direct member calls
- basic explicit types
- simple aliases
- template-independent members when facts suffice

Not promised:
- full template instantiation
- complete ADL
- SFINAE/concepts parity
- complete overload resolution
- preprocessor semantic expansion
- Clang-equivalent checking

Target depth: conservative.

## 19. Semantic support floor

A language may be claimed as supported only after passing applicable tests for:

- cross-file module/import resolution
- local binding
- direct call
- declared or constructor-derived type inference
- receiver/member resolution when applicable
- assignment propagation
- basic parameter propagation
- basic return propagation
- ambiguity preservation
- unknown preservation
- deterministic repeated result
- operation-budget behavior
- no name-only guessed edges

A language that does not meet its applicable floor must be reported as experimental/partial rather than silently claimed complete.

## 20. ParsedFacts sufficiency audit

Before resolver implementation, audit Phase 14A `ParsedFacts` for all eleven target languages.

Audit at least:

```text
scope/binding identity
imports/exports/modules
declaration ownership
constructor evidence
assignment sites
parameters
return annotations
member ownership
inheritance/interface/trait data
aliases
call receiver/member shape
language-specific ownership constructs
```

Potential missing facts include:

```text
Rust impl owner
Go receiver owner
Swift extension owner
Dart mixin/extension relation
C function-pointer assignment seed
C++ namespace/member ownership
```

Adapters must not reparse source to compensate.

## 21. Facts version policy

If the sufficiency audit proves new persisted facts are required, Phase 14B may perform one intentional `factsVersion` bump.

Preferred sequence:

```text
audit all languages
→ finalize required ParsedFacts additions
→ update extraction contract
→ bump factsVersion once
→ update cache/version tests
→ implement adapters/resolver
```

Avoid repeated facts-version churn.

`factsSchemaVersion`, `factsVersion`, `parserIdentity`, `resolutionVersion`, and `derivedVersion` remain distinct domains.

## 22. Generation-safe resolution lifecycle

Phase 14B preserves Phase 14A generation semantics:

```text
active generation N
    ├── fact bindings
    ├── resolved graph
    └── derived state

candidate generation N+1
    ├── candidate fact bindings
    ├── candidate semantic environment
    ├── candidate resolved graph
    └── candidate diagnostics
```

Readers keep seeing N while N+1 is built.

N+1 publishes atomically only after validation.

No half-old/half-new graph is externally visible.

## 23. Two-pass model

### Pass 1 — Environment construction

```text
relevant ParsedFacts
→ adapter normalization
→ deterministic evidence merge
→ module/symbol/type/member environment
```

### Pass 2 — Resolution

```text
call/reference/member sites
→ strategy pipeline
→ ResolutionDecision
```

Additional assignment/return/parameter/chained propagation may run in bounded deterministic rounds.

Do not resolve each file immediately before the repository environment is available.

## 24. No open-ended fixed point

Forbidden:

```ts
while (changed) {
  inferEverythingAgain();
}
```

Use bounded propagation rounds and operation budgets.

Remaining uncertainty becomes `unknown`, `ambiguous`, or `budget_exhausted`.

## 25. Parse invalidation vs resolution invalidation

Keep these separate.

Example:

```text
parse:
  changed file only

resolution:
  changed file + direct importers
```

Importer `ParsedFacts` are reused from cache.

Metrics must distinguish:

```text
parsedFiles
reusedFactFiles
resolvedFiles
```

## 26. Resolution-version semantics

When only resolver semantics change:

```text
resolutionVersion N → N+1
```

Expected:

```text
ParsedFacts reused
TypeEnvironment rebuilt
ResolvedGraph rebuilt
parsedFiles = 0
```

This is mandatory acceptance coverage.

## 27. Incremental resolution policy

Default:

```text
changed files
+
direct importers
```

When dependency provenance cannot safely bound impact:

```text
repository-wide resolution
using cached ParsedFacts
```

Fallback reasons may include:
- unresolved import topology
- module configuration changes
- adapter semantic changes
- symbol moves across modules
- export ambiguity
- incomplete dependency provenance
- resolution-version changes
- broad facts-version changes
- repository identity/configuration changes

Correctness beats minimizing resolution work.

## 28. Semantic invalidation optimization is deferred

Phase 14B may compute future-use surface hashes/classifications.

It must not yet use them to suppress importer resolution.

Deferred classifications include:
- body-only change
- signature change
- export change
- type-interface change
- import/module change

## 29. GenerationResolverContext

Conceptually:

```ts
interface GenerationResolverContext {
  generationId: GenerationId;
  repositoryIdentity: RepositoryIdentity;
  parsedFactsView: ParsedFactsView;
  languageRegistry: LanguageSemanticRegistry;
  typeEnvironment: TypeEnvironment;
  budgets: ResolverBudgets;
  memo: ResolverMemo;
  diagnostics: ResolverDiagnosticsCollector;
}
```

No mutable resolver state may leak between active and candidate generations.

## 30. Parallelism and determinism

Allowed:
- per-file evidence normalization
- independent resolution sites
- diagnostic aggregation

Required pattern:

```text
parallel evidence production
→ deterministic merge/order
→ immutable/deterministically built TypeEnvironment
→ parallel site resolution
→ deterministic graph publication
```

Same snapshot/version/config must produce the same normalized graph across:
- repeated runs
- cold/warm memo
- single-thread
- parallel execution

Differences are bugs except explicitly excluded nondeterministic metadata.

## 31. Resolver diagnostics

Required categories:

```text
resolved
ambiguous
unknown
unsupported
budgetExhausted
weakEvidenceDropped
candidateOverflow
```

Aggregate by:
- repository
- language
- file
- strategy
- edge kind
- capability

Example:

```json
{
  "language": "python",
  "callSites": 812,
  "resolved": 697,
  "ambiguous": 31,
  "unknown": 71,
  "unsupported": 8,
  "budgetExhausted": 5
}
```

## 32. Coverage primitives

Track at least:

```text
applicable
supported
attempted
resolved
ambiguous
unknown
unsupported
budgetExhausted
```

Not-applicable capabilities are excluded from denominators.

Example:

```text
Python receiver/member
applicable: 500
attempted: 500
resolved: 420
ambiguous: 20
unknown: 60
```

For C:

```text
OO inheritance:
support = not-applicable
```

## 33. Authoritative-negative semantics

If relevant coverage is incomplete, a zero-result query may say:

```text
no known callers found
```

but must not claim:

```text
this symbol has no callers
```

Phase 14B must preserve existing `mayBeIncomplete` semantics and feed Phase 14D with enough diagnostics to make authority decisions explicit.

## 34. Failure policy

### Malformed user source

```text
partial ParsedFacts
→ partial SemanticEvidence
→ partial resolution
→ diagnostics
→ generation may publish incomplete
```

### Unsupported construct

```text
UNSUPPORTED
→ no guessed edge
→ generation may publish incomplete
```

### Budget exhaustion

```text
BUDGET_EXHAUSTED
→ no guessed edge
→ generation may publish incomplete
```

### Resolver infrastructure failure

```text
candidate generation fails
→ active generation unchanged
```

### Corrupt/inconsistent environment

```text
candidate generation fails
→ no publication
```

Central distinction:

> Semantic uncertainty is publishable. Infrastructure inconsistency is not.

## 35. Multi-language degradation

Partial support in one language must not make the whole repository unavailable.

Example:

```text
TypeScript: healthy
Rust: healthy
C++: partial

repository graph:
ready but incomplete
```

Diagnostics must identify the source of incompleteness.

## 36. Framework boundary

Phase 14B understands programming-language semantics:

```text
new AuthService()
service.refresh()
class inheritance
trait/interface relations
parameter/return types
```

Phase 14C understands framework conventions:

```text
@Inject(AuthService)
Depends(get_auth_service)
@Autowired
ref.read(authProvider)
```

No framework-specific magic should leak into 14B.

## 37. Test organization

Suggested fixtures:

```text
test/fixtures/resolver/
├── javascript/
├── typescript/
├── python/
├── java/
├── kotlin/
├── go/
├── rust/
├── swift/
├── dart/
├── c/
└── cpp/
```

Applicable concepts:

```text
local-binding
imports
constructor
assignment
parameter
return
member
inheritance
interface-or-trait
alias
ambiguous
unknown
unsupported
budget
```

## 38. Cross-language conformance

Equivalent semantic concepts should produce equivalent decision semantics across languages.

Example:

```text
construct object
→ bind variable
→ call member
```

Expected where applicable:

```text
status = resolved
one structurally supported target
valid provenance
deterministic output
```

## 39. Complexity metrics

Track deterministic operation counts:

```text
resolutionAttempts
strategyInvocations
candidateExpansions
bindingLookups
memberLookups
propagationHops
memoHits
memoMisses
budgetExhaustions
```

Wall-clock benchmarks are separate.

## 40. Incremental acceptance tests

### Cold repository
For N relevant files:

```text
parsedFiles = N
```

### Unchanged rebuild

```text
parsedFiles = 0
facts reused
```

### One source change

```text
parsedFiles = 1
changed file resolves
direct importers may re-resolve
importer facts reused
```

### Resolution-version bump

```text
parsedFiles = 0
repository-wide resolution allowed
```

### Uncertain dependency impact

```text
repository-wide resolution
no unnecessary repository-wide parse
```

### Graph equivalence

Incremental normalized graph must equal clean full rebuild normalized graph, excluding explicitly nondeterministic metadata.

## 41. Determinism acceptance tests

For the same source snapshot, facts version, resolution version, and config, normalized graph/decisions must match across:
- repeated execution
- cold memo
- warm memo
- single-thread
- parallel execution

## 42. Language target depth

| Language | Phase 14B target |
|---|---|
| TypeScript | deep |
| JavaScript | deep |
| Java | deep |
| Kotlin | deep |
| Go | deep |
| Rust | strong |
| Dart | strong |
| Swift | strong |
| Python | conservative/strong |
| C | structural/strong where static |
| C++ | conservative |

These labels do not replace measured capability diagnostics.

## 43. Correctness acceptance criteria

Must demonstrate:
- no guessed ambiguous edges
- lexical/local binding resolution
- cross-file module/import resolution
- constructor-instance inference
- assignment propagation
- parameter propagation
- return propagation
- alias resolution
- receiver/member resolution
- inheritance/interface/trait resolution where applicable
- bounded chained-call propagation
- explicit ambiguity
- explicit unknown
- explicit unsupported
- explicit budget exhaustion
- weak evidence rejection
- edge provenance

## 44. Multi-language acceptance criteria

For all eleven claimed languages:
- capability profile explicit
- applicable semantic floor tested
- unsupported constructs observable
- ambiguity not guessed
- unresolved remains unknown
- deterministic execution demonstrated
- adapters do not reparse source

Languages that fail the semantic floor must not be advertised as fully supported.

## 45. Incremental/generation acceptance criteria

Must demonstrate:
- active generation remains readable during candidate resolution
- failed candidate does not replace active generation
- one changed source parses once
- cached importer facts reused
- resolution-version bump causes zero source parses
- full-resolution fallback uses cached facts
- publication is atomic
- incremental normalized graph equals clean full rebuild

## 46. Regression acceptance criteria

Before closing Phase 14B:
- full project suite passes
- Phase 14A suite passes
- Phase 13/read-only suite passes
- read-only operations do not mutate index state
- SQLite/WAL read-only semantics remain correct
- capability/provider status semantics remain correct
- freshness semantics from Phase 14A remain correct
- CLI compatibility passes
- MCP compatibility passes
- build passes
- lint passes
- TypeScript checks pass
- UI typecheck passes
- packed npm install smoke passes
- packed pnpm install smoke passes
- MCP initialize smoke passes
- `git diff --check` passes

## 47. Migration and compatibility

Preserve Phase 14A migration rules.

No graph-to-facts reconstruction.

If a facts-version bump is required:
- incompatible legacy facts are not reused
- source is re-extracted through mutating indexing flow
- read-only paths perform no migration/writes
- active generation remains valid until candidate publication succeeds

A resolution-version bump should reuse compatible facts.

## 48. Operational observability

Internally measure at least:

```text
parsedFiles
reusedFactFiles
resolvedFiles
resolutionAttempts
resolvedDecisions
ambiguousDecisions
unknownDecisions
unsupportedDecisions
budgetExhaustedDecisions
weakEvidenceDropped
candidateOverflow
memoHits
memoMisses
```

These become inputs to Phase 14D.

## 49. Safety properties

Phase 14B must not require executing repository code.

Language analysis remains static.

Adapters must not invoke project build scripts merely to resolve graph semantics.

Any future compiler/LSP enrichment must be optional and separately designed.

## 50. Performance principles

Priority order:

1. correctness
2. deterministic bounded work
3. Phase 14A fact reuse
4. predictable memory usage
5. semantically deterministic parallelism

Do not trade correctness for speed by guessing targets.

## 51. Public API behavior

Phase 14B primarily improves existing graph/retrieval intelligence.

It does not require a separate public family of resolver tools.

Existing callers/callees/impact/trace/search/change-intelligence operations may become more accurate because accepted graph edges improve.

Diagnostics/capability coverage may be exposed through existing diagnostics or Phase 14D surfaces.

Public contracts must not imply complete semantic coverage where it is incomplete.

## 52. Scope lock

### In scope

```text
ParsedFacts sufficiency audit
at most one intentional factsVersion bump if required
multi-language adapters
shared semantic evidence vocabulary
generic TypeEnvironment
strategy-based resolver
categorical confidence
edge provenance
ambiguity preservation
UNKNOWN/UNSUPPORTED/BUDGET_EXHAUSTED
operation budgets
memoization
bounded propagation
generation-safe resolution
incremental resolution invalidation
coverage primitives
resolver diagnostics
11-language semantic floor
```

### Out of scope

```text
framework-specific graph semantics
framework plugin system
semantic invalidation optimization
watcher
compiler-grade semantics
mandatory LSP/compiler integration
embeddings
internal LLM resolution
Context Intelligence
context(task)
context-aware reads
repository memory
```

## 53. Design rationale

### Shared resolver
A resolver per language would duplicate binding lookup, propagation, ambiguity rules, budgets, provenance, memoization, and acceptance logic. The adapter architecture centralizes conclusions while preserving language-specific syntax normalization.

### Eleven languages now
The architecture should be exercised against materially different language models early enough to avoid baking TypeScript assumptions into the core. Equal depth is not required; truthful partial coverage is preferred.

### No required compiler/LSP
Compiler/LSP dependencies increase installation complexity, platform variability, latency, and failure modes. Phase 14B establishes deterministic local resolution from CodeAtlas-owned facts first.

### Conservative C++
False C++ edges are more damaging to change intelligence than missing low-confidence edges. Structurally obvious cases resolve; compiler-grade cases remain unsupported/unknown.

### Operation budgets
Time cutoffs create hardware-dependent semantics. Operation budgets keep correctness reproducible.

### Semantic invalidation deferred
Phase 14A already makes repository-wide resolution safe without repository-wide parsing. Suppressing importer work should wait until semantic surfaces are proven sound.

## 54. End-state

After Phase 14B, CodeAtlas should be able to explain:

```text
Resolved:
- local binding identified
- constructor evidence established receiver type
- member exists on that type
- one structurally supported target remained
```

or:

```text
Ambiguous:
- multiple plausible implementations remained
```

or:

```text
Unsupported:
- C++ template semantics require compiler-grade analysis
```

or:

```text
Budget exhausted:
- deterministic candidate limit was reached
```

This is the required foundation for Phase 14C framework edges, Phase 14D coverage telemetry, and Phase 15 Context Intelligence.

## 55. Final design statement

Phase 14B turns CodeAtlas resolution into a bounded, explainable, multi-language semantic resolution engine.

The design favors:

```text
precision over guessed coverage
explicit uncertainty over silent failure
shared semantics over language silos
cached facts over repeated parsing
determinism over timing-dependent heuristics
generation safety over in-place mutation
```

The graph may remain incomplete where language/runtime semantics cannot be established safely, but accepted edges become more trustworthy and missing coverage becomes observable.
