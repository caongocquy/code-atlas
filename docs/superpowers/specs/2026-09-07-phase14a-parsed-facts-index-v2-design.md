# Phase 14A — ParsedFacts and Index/Cache/Invalidation v2

**Status:** Approved design specification
**Scope:** Documentation only; this document defines Phase 14A architecture and contracts.
**Implementation boundary:** Phase 14A does not implement Resolver v2.

## 1. Context and motivation

Phase 13 is complete. Phase 14-0 audited GitNexus, CodeGraph, and Codebase-
Memory-MCP as architectural references.

The audit established the following useful lessons:

- GitNexus has the strongest durable parsed-fact reuse, a clean parse/resolution
  separation, and useful content-addressed cache ideas.
- CodeGraph demonstrates strong Git-native discovery, incremental SQLite repair,
  and bounded parser/runtime behavior.
- Codebase-Memory-MCP demonstrates strong resolver engineering, bounded work and
  memoization, race-safe indexing, and useful lessons for bulk graph assembly.

CodeAtlas retains the properties that fit its product and existing contracts:

- lightweight Node.js and TypeScript runtime;
- SQLite as the local storage foundation;
- precision-first behavior;
- explicit incompleteness rather than invented certainty;
- source-snapshot correctness; and
- Phase 13 Change Intelligence semantics.

Phase 14A addresses four related problems:

1. repeated structural parsing of the same source;
2. the absence of a durable raw-facts boundary;
3. coarse invalidation and versioning; and
4. unnecessary coupling between parsing and resolution.

Phase 14A does not implement Resolver v2, semantic invalidation, or any later
resolver framework. Its purpose is to make structural facts reusable and to
make index generation and invalidation explicit without changing the meaning of
existing resolved graph results.

## 2. Core architecture

The canonical pipeline is:

```text
SourceSnapshot
    ↓
content hash
    ↓
ParsedFactsBlob
    ↓
FileFactBinding
    ↓
MaterializedFileFacts
    ↓
InvalidationPlan
    ↓
existing Resolver
    ↓
ResolvedGraph
    ↓
derived indexes / Change Intelligence
```

The core invariant is:

> ParsedFacts are what source structurally says. ResolvedGraph is what
> CodeAtlas concludes from those facts.

ParsedFacts contain syntax-derived evidence and binding seeds. They do not
contain resolver conclusions. In particular, resolved targets, resolved edges,
or other path- and repository-dependent conclusions MUST NOT be persisted
inside ParsedFacts.

The resolver consumes materialized facts and remains the owner of resolution
decisions. Derived indexes and Change Intelligence consume the resolved graph
and remain downstream projections.

## 3. Path-neutral fact blob

### 3.1 ParsedFactsBlob contract

`ParsedFactsBlob` is the immutable, reusable structural extraction result for a
single coherent source generation. Conceptually it contains:

```text
ParsedFactsBlob {
  factsSchemaVersion
  factsVersion
  contentHash
  language
  parserIdentity
  parseStatus
  parserDiagnostics
  symbols[]
  containmentScopes[]
  imports[]
  exports[]
  references[]
  callSites[]
  bindingSeeds[]
  declaredTypeAnnotations[]
}
```

The exact TypeScript representation may follow existing repository conventions.
The three fact metadata fields have non-overlapping ownership:

- `factsSchemaVersion` owns the serialized and validated shape of the
  `ParsedFactsBlob`. It changes when that persisted fact schema changes
  incompatibly, such as when a field is added with incompatible semantics, or
  renamed or removed, or when the serialization contract changes.
- `factsVersion` owns CodeAtlas extraction semantics: what structural facts
  mean and how CodeAtlas extracts them. It changes for changes such as a new
  call-site extraction rule, containment semantics, import/export fact
  semantics, or binding-seed interpretation. It MUST NOT change merely because
  the concrete Tree-sitter runtime or grammar package version changed when
  extraction semantics remain unchanged.
- `parserIdentity` identifies the concrete parser, runtime, and relevant
  grammar identity/version assumptions used to produce the facts. It SHOULD
  deterministically represent those inputs and changes when they could alter
  parse output. It participates in `FactBlobKey` and cache validation; it is
  not a replacement for `factsVersion`.

`parseStatus` is `complete` or `deterministic_partial`. `parserDiagnostics`
MUST preserve source syntax diagnostics for a partial parse and MUST
distinguish that valid deterministic result from an internal parser or
extraction failure. Infrastructure failure has no authoritative
`ParsedFactsBlob` and therefore no published `parseStatus`.

The blob MUST be path-neutral wherever the source syntax does not provide path
evidence. Raw fact identities are local to the source blob, for example:

```text
symbol:12
scope:3
call:7
```

An identity such as `src/foo.ts::Foo.bar` MUST NOT be used as the raw fact
identity when the path itself is not syntax evidence. Path-sensitive identity
is materialized later from the repository-relative binding and the current
resolution context.

The blob MAY retain source-derived module specifiers, names, and literal source
locations where those are required evidence. It MUST NOT turn a repository path
or a resolved target into a supposed syntax fact merely to improve cache hits.

### 3.2 Fact identity

`FactBlobKey` is separate from `FileFactBinding`.

The recommended conceptual key is:

```text
FactBlobKey = hash(
  source content hash
  + language
  + parserIdentity
  + factsVersion
  + factsSchemaVersion
)
```

`parserIdentity` MUST change when parser, runtime, or grammar inputs change in a
way that could alter parse output. It remains distinct from `factsVersion`:
the parser provenance can change without changing CodeAtlas extraction
semantics, and extraction semantics can change without being reducible to a
concrete parser package version.

`FileFactBinding` maps repository context to a reusable blob:

```text
FileFactBinding {
  repositoryId
  relativePath
  factBlobKey
  contentHash
  generationId
}
```

This enables a same-content rename to reuse the `ParsedFactsBlob`, update the
path binding, and rerun path- or module-sensitive resolution without invoking
Tree-sitter again.

Fact blob reuse MUST NOT be described as stable semantic symbol identity across
a rename or a rename of a symbol. Global stable symbol identity redesign is
deferred.

## 4. Materialization boundary

The resolver input is:

```text
MaterializedFileFacts {
  relativePath
  ParsedFactsBlob
}
```

Materialization is the boundary at which repository-relative path, current
generation, and other context-dependent information become available. The
resolver MUST consume this boundary instead of independently reopening and
reparsing source to recover facts already represented in the blob.

Graph construction and lexical indexing MUST reuse the canonical extraction
result. Full source text MAY still be consumed when lexical indexing genuinely
needs text, but Tree-sitter extraction MUST NOT be duplicated by a graph pass
and a lexical pass.

## 5. Version domains

The index has four independent version domains:

| Domain | Owns | Required invalidation |
| --- | --- | --- |
| `schemaVersion` | Persistent database and storage-layout compatibility | Storage migration or rebuild according to existing lifecycle rules |
| `factsVersion` | Parser/extractor/grammar assumptions and ParsedFacts semantics | Rebuild ParsedFacts for relevant source files |
| `resolutionVersion` | Resolver algorithms and resolved-edge semantics | Reuse ParsedFacts; rebuild the resolved graph |
| `derivedVersion` | Lexical and other derived projections | Retain compatible facts and graph; rebuild derived projections only |

`factsSchemaVersion` is separate fact-blob compatibility metadata, not a
collapse of `factsVersion` and not a fifth resolver or derived-version domain.
It is evaluated as part of fact-blob validation before facts are reused.

Version changes MUST invalidate only the layer whose semantics changed, subject
to storage compatibility and explicit safety fallback rules.

The required semantics are:

- `factsVersion` change: invalidate and rebuild ParsedFacts.
- `resolutionVersion` change: reuse ParsedFacts and rebuild the resolved graph;
  unchanged source MUST NOT be reparsed.
- `derivedVersion` change: retain facts and the compatible resolved graph, then
  rebuild only derived projections.
- `schemaVersion` change: use the existing explicit mutating migration or
  rebuild lifecycle; read-only operations remain non-mutating.

## 6. Fact cache storage

Phase 14A uses the existing SQLite architecture. It MUST NOT introduce a new
storage engine, external vector database, or mandatory service.

The conceptual storage model is:

```text
repository_index_state
  repository_id
  active_generation_id
  active_schema_version
  active_facts_version
  active_resolution_version
  active_derived_version
  active_provenance_metadata

fact_blobs
  blob_key
  facts_version
  facts_schema_version
  language
  parser_identity
  content_hash
  encoded_payload
  validation_metadata

file_fact_bindings
  repository_id
  generation_id
  relative_path
  blob_key
  content_hash
  validated_provenance
```

The exact table and column names may follow the existing SQLite schema, but the
stored data MUST preserve the separation between immutable blob identity and
path-specific, generation-specific binding identity. A binding for candidate
generation N+1 MUST NOT overwrite the active generation N binding in place.

Normal readers resolve repository state through
`repository_index_state.active_generation_id`. They MUST then read only
bindings, manifests, graph state, and derived state belonging to that active
generation. Fact blobs remain immutable/content-addressed and may exist
independently of any active generation.

The v1 payload format is compact, inspectable JSON. Protobuf, MessagePack, or
another binary format is not required. ParsedFacts MUST NOT persist an AST,
embeddings, or full source solely to support this cache. A serialization
optimization requires profiling evidence before adoption.

## 7. Cache semantics and validation

A cache hit requires all of the following to match:

- source content hash;
- language;
- `parserIdentity`;
- `factsVersion`; and
- `factsSchemaVersion`.

The mismatch meanings are distinct:

- `factsSchemaVersion` mismatch means the persisted blob shape is incompatible;
  the blob is discarded and facts are rebuilt or reparsed as required.
- `factsVersion` mismatch means CodeAtlas extraction semantics changed; facts
  are rebuilt.
- `parserIdentity` mismatch means parser/runtime/grammar provenance changed;
  facts are rebuilt for the affected language or source.

No parser/runtime/grammar change that could alter parse output may silently
reuse an incompatible blob. A parser identity change that is known not to
alter extraction semantics still requires fresh fact provenance under the new
identity, while it does not imply a `factsVersion` change.

On a hit, the existing valid facts blob is reused without parsing.

On a miss, the lifecycle is:

```text
parse once
  → extract facts
  → validate facts and provenance
  → publish immutable/content-addressed blob
```

The following conditions make a cache entry unusable:

- invalid JSON;
- invalid facts schema;
- content-hash mismatch;
- facts-version mismatch;
- parser-identity mismatch; or
- any other validation failure that means the payload cannot be trusted as the
  facts for the requested source generation.

An unusable entry is treated as a cache miss. The implementation reparses,
validates, and safely recreates the entry. Corrupt facts MUST NOT be trusted or
used as an authoritative input to resolution.

## 8. Source race safety

For mutable working-tree sources, fact publication MUST prove that parsing used
one coherent source generation:

```text
capture/hash source generation
  → parse and extract
  → capture/hash source generation again
```

If the source changed during this operation, the candidate is discarded and the
operation retries once. If the source changes again:

- candidate facts are discarded;
- the candidate generation is not published;
- the previous active generation remains authoritative; and
- the lifecycle exposes or reports an indexing failure/incomplete state.

No mixed-generation graph may become active.

Historical Git snapshots have stronger immutability properties and SHOULD reuse
the existing Phase 13 source-snapshot semantics where applicable.

## 9. Active index-generation manifest

Phase 14A introduces an active index-generation manifest. Conceptually:

```text
IndexManifest {
  repositoryId
  generationId
  versions {
    schemaVersion
    factsVersion
    resolutionVersion
    derivedVersion
  }
  files[] {
    relativePath
    contentHash
    language
    factBlobKey
  }
}
```

Manifest comparison is the canonical basis for incremental work. Changed,
added, deleted, and renamed paths are determined from source snapshots and
manifest comparison, with content hashes remaining authoritative. The
implementation MUST NOT infer changed files by reverse-engineering the graph.

The manifest is generation-scoped. Readers locate the visible manifest through
`repository_index_state.active_generation_id` and MUST NOT read a staged
candidate manifest as normal repository state. A candidate manifest may be
constructed for N+1, but it becomes readable only after the active-generation
pointer is atomically switched.

## 10. Invalidation model

Phase 14A deliberately implements:

```text
changed file + direct importers
```

It does not implement semantic invalidation categories such as body-only,
signature, export-surface, or interface/type-surface invalidation. Those
categories are deferred until ParsedFacts and Resolver v2 provide reliable
contracts.

Parse invalidation and resolution invalidation are separate decisions:

- Parse invalidation: changed source content requires parsing that file;
  unchanged source reuses ParsedFacts.
- Resolution invalidation: a changed file and affected direct importers may
  require resolution even when their own facts are reused.

Resolution invalidation may therefore be wider than parse invalidation.

### 10.1 Reverse importer index

Phase 14A creates or derives a lightweight reverse dependency relation:

```text
imported module/file → direct importers
```

The relation may be derived from ParsedFacts imports and materialized module
resolution. It does not require symbol-level dependency invalidation,
compiler-level type-consumer invalidation, or semantic change classification.

### 10.2 Dependency-impact confidence

Every invalidation decision has explicit dependency-impact confidence:

```text
bounded | uncertain
```

When impact is bounded, the resolver processes changed files and direct
importers. When impact is uncertain, the implementation performs repository-wide
re-resolution using reusable ParsedFacts.

Uncertain dependency impact MUST NOT cause repository-wide reparsing. The safety
payoff of ParsedFacts is:

```text
uncertain invalidation → broader resolution, not full parsing
```

Broader re-resolution is appropriate, for example, when a new file may satisfy
a previously unresolved global candidate set, when a removed or moved module
may invalidate fallback resolution, or when dependency closure cannot be
proven. Correctness takes precedence over minimizing resolution work.

### 10.3 Deterministic planner

Invalidation decisions belong in a pure deterministic planner rather than being
scattered across parser, synchronization, database, and resolver code.

The conceptual API is:

```text
planInvalidation(input) → InvalidationPlan
```

The plan separates at least:

- files to parse;
- files whose facts are reused;
- files to resolve;
- deleted paths;
- whether a full resolved-graph rebuild is required;
- whether derived projections rebuild;
- whether dependency impact is bounded or uncertain; and
- machine-readable and human-readable reasons.

The planner MUST be deterministic for the same source manifest, active manifest,
version set, and available dependency evidence.

## 11. Exact file-change semantics

| Change | ParsedFacts behavior | Resolution behavior |
| --- | --- | --- |
| Unchanged | Reuse blob | Reuse unless dependency or version invalidation applies |
| Modified | Parse and publish a new blob | Resolve the file and known direct importers |
| Deleted | Remove its active file binding | Remove stale nodes and edges, then resolve known importers |
| Added | Parse and publish a new blob | Resolve relevant dependents and unresolved candidate space; use broader resolution when bounded impact cannot be proven |
| Renamed, same content | Reuse blob and update path binding | Rerun path/module-sensitive resolution; do not reparse merely because the path changed |
| Moved across module boundary, same content | Reuse syntax facts | Rerun dependency/module resolution for the new boundary |

Resolution version changes may force graph-wide resolution while still reusing
all compatible ParsedFacts. Facts version changes require rebuilding facts for
all source files affected by the changed parser/facts contract. Derived version
changes do not require parsing or resolver work when the graph remains
compatible.

## 12. Atomic generation publication

The active generation and the candidate generation are distinct:

```text
active generation N
  → build candidate N+1
  → parse/cache missing facts
  → resolve
  → build derived state
  → validate
  → atomically publish N+1
```

Candidate generation N+1 may stage generation-scoped bindings, a manifest,
graph state, and derived state. These staged records are not visible to normal
readers because readers follow `repository_index_state.active_generation_id`,
which still points to N.

The final publication step MUST atomically switch the repository's active
generation pointer from N to N+1 together with the minimum version and
provenance metadata required for consistency. It MUST NOT publish candidate
bindings by overwriting active N bindings before that switch.

Any failure before the final switch leaves `active_generation_id` equal to N.
Candidate bindings and candidate graph or derived state MUST NOT become active.
Read-only commands MUST NOT switch the pointer, repair candidate state, migrate
generation state, or promote staged bindings.

Immutable fact blobs produced during an aborted candidate build MAY remain as
temporarily unreferenced cache blobs. Candidate-generation cleanup or GC MAY
occur later, but no binding may make an unpublished generation active.

## 13. Fact-cache garbage collection

Fact-cache garbage collection is intentionally simple. After successful
publication:

```text
all fact blobs
  − blobs referenced by committed active-generation bindings
    and any intentionally retained generation policy
  = eligible orphan blobs
```

Only committed active-generation references, plus any intentionally retained
generation policy defined by the implementation, make a blob active or
referenced for GC. Phase 14A does not add historical-generation browsing,
rollback UI, a public generation CLI, or a background generation manager. It
also does not add LRU, TTL, configurable cache limits, or a background cache
daemon; those features require measured operational requirements.

## 14. Error and degradation semantics

User source syntax errors and CodeAtlas infrastructure failures are distinct.

### 14.1 CASE A — User source and deterministic partial parse

This case covers malformed or incomplete user code where Tree-sitter returns a
valid partial or error-containing tree and extraction can deterministically
produce structurally safe partial facts. The blob carries
`parseStatus: deterministic_partial`:

- the partial facts MAY be cached;
- parser diagnostics MUST be stored with the facts;
- downstream analysis MUST expose explicit incompleteness; and
- unchanged malformed source MUST NOT be continuously reparsed.
- no authoritative-negative conclusion may be inferred beyond existing
  CodeAtlas completeness rules.

Partial facts are evidence with diagnostics, not a claim that the source is
fully understood.

### 14.2 CASE B — CodeAtlas parser or extraction infrastructure failure

An internal parser or extraction failure is distinct from malformed user source:
unexpected parser exception, extraction invariant violation, internal timeout
or failure without trustworthy deterministic facts, corrupted parser state, and
other infrastructure-level failures belong here. Such a failure:

- MUST NOT publish an authoritative `ParsedFactsBlob`;
- MUST NOT publish candidate generation N+1;
- leaves previous active generation N active;
- reports an indexing failure or incomplete state through the lifecycle;
- leaves read-only surfaces observational and unable to repair the state; and
- retries only through the normal explicit mutating lifecycle, apart from the
  bounded source-race retry already defined.

Infrastructure parser or extraction failure MUST fail candidate publication. An
implementer MUST NOT choose to publish an incomplete generation for this case.
It MUST NOT silently become a valid facts blob merely because it has a content
hash.

### 14.3 Other failure categories

The implementation may classify failures internally using categories such as:

```text
source_raced
fact_cache_corrupt
fact_cache_write_failed
parser_failed
manifest_invalid
publication_failed
unsupported_legacy_state
```

These categories are for lifecycle safety, diagnostics, and tests. Phase 14A
does not create a new public API solely to expose them.

Cache persistence failure means the candidate fact cache was not successfully
persisted. The lifecycle MUST NOT report it as persisted and MUST NOT publish an
inconsistent new generation.

## 15. Read-only invariant

Phase 13 read-only guarantees remain intact. The following read-only commands,
and any equivalent read-only analysis surface, MUST NOT:

- migrate a database;
- populate the fact cache;
- update repository timestamps;
- repair bindings;
- index or sync; or
- publish a new generation.

Readers resolve state through the committed active-generation pointer and MUST
observe only the bindings, manifests, graph state, and derived state belonging
to that generation. They MUST NOT promote or repair candidate state.

The protected examples are:

```text
status
inspect_change
affected_tests
explain_incomplete
graph_delta
architecture_drift
change_gate
```

Read-only operations may inspect an existing active manifest, facts, graph, and
diagnostics, but they cannot repair or materialize missing state. Legacy and
current state must therefore remain observationally safe through these paths.

## 16. Legacy index transition

Phase 14A MUST NOT reconstruct ParsedFacts from legacy resolved graph data.
Resolved graph data does not contain sufficient or trustworthy raw structural
provenance for that purpose.

On the first explicit mutating lifecycle operation after upgrade, the legacy
index transitions as follows:

```text
legacy index
  → full source extraction once
  → populate ParsedFacts
  → resolve
  → build candidate generation
  → publish
```

Read-only access to a legacy index remains non-mutating wherever current
contracts allow. If provenance is insufficient, a full source rebuild is the
correctness fallback. Migration occurs only through an explicit mutating
lifecycle such as `init`, `index`, or `sync`.

## 17. Module ownership and boundaries

Existing repository structure should be reused where possible. Directory names
are illustrative; unnecessary directory churn is out of scope. The conceptual
ownership boundaries are:

```text
core/facts
  fact contracts
  local fact identity
  validation and codec
  no SQLite, CLI, or MCP knowledge

core/index
  manifests
  version domains
  invalidation planning
  generation lifecycle
  importer index

infrastructure/facts
  fact persistence only

repository/source infrastructure
  coherent source capture and hashing

graph/resolver
  consumes MaterializedFileFacts
  does not bypass the facts boundary
```

The facts core is portable and testable without a database. Persistence knows
how to store and retrieve validated blobs but does not own resolver semantics.
The resolver does not reopen and reparse source to bypass the canonical facts
boundary.

## 18. Fixture and regression matrix

Phase 14A requires fixture families for facts, cache, invalidation,
publication, migration, and Phase 13 regression behavior. The matrix must cover
at least these scenarios:

1. cold index;
2. identical second index;
3. one modified leaf;
4. one modified dependency;
5. delete dependency;
6. add a module satisfying a previously unresolved reference or import;
7. rename a same-content file;
8. move a same-content file across a module boundary;
9. revert to a previously cached content blob;
10. `factsVersion` bump;
11. `resolutionVersion` bump;
12. `derivedVersion` bump;
13. corrupted fact blob;
14. unchanged syntax-error file;
15. internal parser failure;
16. source changes during parsing once;
17. source races twice;
18. interruption before candidate publication;
19. removed import;
20. repeated identical indexing;
21. dependency-impact uncertainty fallback;
22. legacy read-only access;
23. legacy mutating migration; and
24. cache-hit versus fresh-parse semantic equivalence.

Fixtures should assert observable contracts rather than implementation details:
cache hit/miss counts, parsed and resolved file sets, active generation
selection, stale-edge removal, incompleteness diagnostics, and normalized graph
equivalence.

## 19. Determinism and correctness invariants

The following equivalences are mandatory:

```text
fresh parse facts == cache round-trip facts
resolve(fresh facts) == resolve(cached facts)
incremental result == clean full-rebuild result
```

The comparison normalizes intentionally nondeterministic metadata only. It
must not hide differences in symbols, imports, calls, resolved targets, graph
edges, incompleteness, or diagnostics that affect correctness.

Results MUST NOT depend on:

- filesystem traversal order;
- cache hit or miss path;
- repeated execution; or
- worker scheduling if workers are introduced later.

The active-generation publication rule must preserve these properties even when
a candidate build fails or a source races during capture.

## 20. Performance acceptance metrics

Wall-clock time is not a correctness gate. The index lifecycle instruments
deterministic work counters, at minimum:

```text
filesScanned
filesHashed
factCacheHits
factCacheMisses
filesParsed
filesResolved
importersInvalidated
fullResolutionFallbacks
```

Required acceptance examples are:

| Scenario | Required counters |
| --- | --- |
| 100-file cold index | `filesParsed = 100` |
| Unchanged second index | `filesParsed = 0` |
| Modify one file | `filesParsed = 1` |
| Same-content rename | `filesParsed = 0` |
| `resolutionVersion` bump | `filesParsed = 0`; repository resolution rebuild is allowed and expected |
| `factsVersion` bump | `filesParsed =` all relevant source files |
| `derivedVersion` bump | `filesParsed = 0`; resolver work is `0` when the graph remains compatible |

Tree-sitter parse count MUST equal fact-cache misses, not the sum of separate
graph-index and lexical-index passes.

## 21. Memory constraints

Phase 14A does not adopt a whole-repository RAM-first design. The lifecycle
should avoid retaining all of the following simultaneously when downstream
consumers no longer need them:

- full source text;
- AST;
- ParsedFacts;
- graph state; and
- lexical documents.

AST and source buffers should be released after their downstream consumers no
longer need them. Facts may be processed in batches when that reduces retained
memory without obscuring generation safety. Custom native storage is out of
scope without profiling evidence.

## 22. Explicit exclusions

Phase 14A MUST NOT include:

- semantic invalidation;
- Resolver v2 `TypeEnvironment`;
- broad return or type propagation;
- a framework resolver registry;
- framework recognizers;
- a watcher;
- a shared daemon;
- embeddings or semantic-retrieval expansion;
- communities;
- process discovery;
- global stable symbol identity redesign;
- a native SQLite rewrite; or
- public fact/cache CLI commands.

These belong to later phases or require evidence that is not part of this
approved design.

## 23. Phase 14B boundary

Phase 14B builds on the ParsedFacts, materialization, version-domain,
generation, and invalidation contracts established here.

The expected later resolver direction is:

```text
scope/local bindings
  → imports/exports
  → constructor/field types
  → assignments
  → parameter types
  → return propagation
  → inheritance/interfaces
  → receiver/member lookup
  → chained calls
  → bounded propagation
  → unique-target gate
  → provenance/diagnostics
```

This document creates the seam needed by that direction. It does not implement
or fully task-plan Phase 14B, Resolver v2, or semantic invalidation.

## 24. Definition of done

Phase 14A is complete only when all of the following are demonstrated:

- ParsedFacts is the canonical structural parser output.
- Unchanged source does not reparse.
- Resolver version changes do not reparse unchanged source.
- A same-content rename can reuse a fact blob.
- Graph and lexical paths do not duplicate Tree-sitter extraction.
- Changed files and direct importers are invalidated correctly.
- Uncertain dependency impact broadens resolution safely.
- Deleted and renamed files leave no stale graph edges.
- Source races cannot publish mixed generations.
- Incremental graph equals a clean full-rebuild graph.
- Legacy read-only paths remain non-mutating.
- Migration happens only under a mutating lifecycle.
- Cache corruption recovers safely.
- Malformed user source may publish only deterministic partial facts with
  diagnostics and explicit incompleteness.
- Infrastructure parser or extraction failure always aborts candidate
  publication and leaves the previous active generation authoritative.
- Candidate-generation bindings cannot become visible before active-pointer
  publication.
- Existing Phase 13 semantics remain unchanged.
- npm/pnpm packaging and MCP behavior remain compatible.

## 25. Design principles

1. Correctness before incremental cleverness.
2. Parsed facts and resolved conclusions are separate.
3. The cache is reusable evidence, not authoritative stale state.
4. Uncertainty broadens resolution, not parsing.
5. Read-only analysis stays read-only.
6. No speculative edge generation is added to improve cache-hit rates.
7. Version only the layer whose semantics changed.
8. Optimize measured work, not marketing benchmarks.
9. Keep Node.js, TypeScript, and SQLite.
10. Build the seam needed by Phase 14B without implementing Phase 14B.

## 26. Self-review checklist

Before the specification is accepted as the Phase 14A checkpoint, review the
document for:

- unresolved unfinished-work markers or unbounded future-work language;
- contradictions between `MUST`, `SHOULD`, and optional behavior;
- distinct ownership for `factsSchemaVersion`, `factsVersion`, and
  `parserIdentity`;
- parser/runtime/grammar changes cannot silently reuse incompatible facts;
- accidental semantic-invalidation scope;
- accidental Resolver v2 scope;
- accidental watcher or daemon scope;
- consistent path-neutral blob identity;
- non-contradictory cache-key and file-binding identity;
- non-mutating legacy read-only behavior;
- active readers observe only the generation named by the committed active
  pointer;
- candidate bindings never overwrite active bindings before publication;
- infrastructure parser failure always aborts candidate publication;
- active-generation preservation on every failure path;
- internally consistent version rules;
- uncertain-dependency fallback that never implies full reparse;
- syntax-error caching distinguished from infrastructure parser failure; and
- preservation of Phase 13 contracts.

The final committed specification must contain no unfinished-work markers or
incomplete requirements. It is a design specification, not an implementation
task plan.
