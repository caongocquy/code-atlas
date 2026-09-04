# CodeAtlas v2 Architecture Plan

## Decisions

| Decision                     | Choice                                                                                               | Reason                                                                                      | Status                                     |
| ---------------------------- | ---------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------ |
| Product name                 | **CodeAtlas**                                                                                        | Short, memorable, matches the product goal: map, search, inspect, and understand a codebase | Decided                                    |
| Repository name              | `code-atlas`                                                                                         | Easier to read than `codeatlas` in GitHub/npm-style contexts                                | Proposed                                   |
| CLI binary                   | `code-atlas`                                                                                         | More readable in terminals than `codeatlas`; keeps the CodeAtlas brand                      | Decided                                    |
| Local config/index directory | `.codeatlas/`                                                                                        | Stable product-specific local state directory                                               | Decided                                    |
| Environment prefix           | `CODEATLAS_`                                                                                         | Clear public configuration namespace                                                        | Proposed                                   |
| Runtime                      | Node.js 24+ for the first public release; validate Node 22/current LTS before publishing             | Current code already uses `node:sqlite` and modern ESM APIs                                 | Proposed; needs runtime matrix spike       |
| Parser                       | Tree-sitter with existing TS/TSX/JS adapters                                                         | Proven parser seam; keep structural parsing local and deterministic                         | Decided                                    |
| Primary storage              | Per-repository `.codeatlas/atlas.db` using built-in SQLite                                           | One local source of truth; zero-config; transactional                                       | Proposed; needs schema/portability spike   |
| Lexical search               | SQLite FTS5                                                                                          | Zero-config, local, fast enough for public default                                          | Proposed; needs ranking/tokenization spike |
| Semantic search              | Optional feature requiring an embedding provider and one built-in local vector backend              | Core must work without model downloads or external services                                 | Decided                                    |
| Vector storage               | Internal `VectorStore` abstraction with SQLite BLOB + cosine as the sole built-in backend | Keep storage replaceable without making vector databases a user choice             | Complete; Phase 6                           |
| Graph model                  | Typed structural graph with stable identity, evidence, ambiguity/drop policy, and coverage signals   | Improves trust and makes graph reasoning inspectable                                        | Proposed                                   |
| LLM requirement              | None in CodeAtlas core; host agents and standalone consumers may provide reasoning                   | Search, graph, inspection, impact, trace must work without generation                       | Decided                                    |
| Reranker                     | Optional `RerankerProvider`                                                                          | Preserve current quality differentiator without making it mandatory                         | Proposed                                   |
| UI                           | Existing React/Vite AI Inspector + Sigma.js + Graphology Graph Explorer                              | Human/debug surface over the same index used by CLI/MCP                                     | Decided                                    |
| CLI progress                 | Keep `listr2`, colors, icons, progress bars, `ProgressReporter`, TTY/non-TTY and `NO_COLOR` behavior | This layer is already complete and must not regress                                         | Decided                                    |
| MCP                          | Add only after core services and capability contracts stabilize                                      | MCP must be an adapter, not a second implementation                                         | Proposed                                   |
| Change detection             | Git metadata narrows sync candidates when available; filesystem scan and content hashes remain authoritative | Faster incremental sync without a Git dependency or freshness blind spots                  | Complete; Phase 4                           |
| Agent integration/init       | Capability-aware `code-atlas init` with a managed `AGENTS.md` block                          | Agents can discover real CodeAtlas capabilities without overwriting repository instructions | Planned after MCP                          |
| Packaging                    | Compiled ESM JS with `code-atlas` bin; no runtime `tsx`, Docker, external vector database, or LLM requirement | Public install must work from another repository                                            | Proposed; needs clean-package spike        |

## Product direction

**CodeAtlas — map, search, and understand your codebase.**

CodeAtlas is not a “RAG app with a graph”.

Target mental model:

```text
Source Repository
        ↓
Code Intelligence Index
        ↓
┌───────────────────────────────┐
│ Structural / Symbol Graph     │
│ Lexical Search                │
│ Optional Semantic Search      │
│ Graph Intelligence            │
└───────────────────────────────┘
        ↓
┌──────────┬──────────┬──────────┐
│ CLI      │ MCP      │ UI       │
└──────────┴──────────┴──────────┘
        ↓
Optional feature integrations
```

RAG and LLM generation are consumers of the index, not core requirements.

CodeAtlas is a code-intelligence engine, not a chat or agent runtime. Host
agents such as Codex, OpenCode, and Claude perform reasoning when they use
CodeAtlas through MCP. CodeAtlas does not require an internal LLM for MCP
usage; the host model interprets structured CodeAtlas results.

Feature-first product model:

```text
Core
├─ Graph
└─ Lexical / FTS5

Optional enhancement
└─ Semantic Search
   └─ EmbeddingProvider + built-in internal VectorStore

Optional enhancement
└─ Reranking
   └─ RerankerProvider
```

A public user must be able to run:

```bash
code-atlas index
code-atlas status
code-atlas search
code-atlas serve
```

without requiring:

- llama.cpp
- Ollama
- OpenAI
- an external vector database
- Docker
- a downloaded embedding model
- a downloaded reranker model

## Implementation status

- Phase 0 — complete
- Phase 1 — complete
- Source-layout refactor — complete
- Phase 2 — complete
- Phase 3 — complete
- Phase 4 — complete
- Phase 5 — complete
- Phase 6 — complete
- Phase 7 — complete
- Phase 8 — complete
- Phase 9 — not started

## External design references

### GitNexus

Repository: [GitNexus](https://github.com/abhigyanpatwari/GitNexus)

Used as reference inspiration for:

- Git-aware repository intelligence
- impact / trace UX
- communities / process concepts
- managed agent instructions
- repository-aware agent workflows

### Graphify

Repository: [Graphify](https://github.com/Graphify-Labs/graphify)

Used as reference inspiration for:

- edge evidence / confidence concepts
- query / explain / path graph UX
- community detection
- hub/noise suppression
- architectural bridge analysis
- agent installation patterns
- optional Git hook refresh
- graph-aware agent navigation
- future PR graph overlap/conflict analysis

External repositories are design references only. They are not authoritative
implementation truth. Once an idea is adopted and rewritten in this plan,
`docs/plan.md` becomes the source of truth for CodeAtlas. Agents must not copy
external repository architecture blindly.

CodeAtlas does not automatically adopt:

- `graph.json` as primary persistence
- NetworkX-centric storage/runtime architecture
- multimodal product scope
- mandatory LLM usage for the code graph
- mandatory graph-first agent behavior
- mandatory daemon/watch architecture
- generic knowledge-graph scope
- hyperedges as a core requirement
- graph files committed to Git as primary state

CodeAtlas remains centered on SQLite AtlasStore, code intelligence, the FTS5
lexical core, an optional semantic/vector layer, a deterministic graph core,
and shared services for CLI, HTTP, UI, and MCP.

The broader command surfaces of GitNexus and Graphify may inspire coverage
checks, but CodeAtlas will not add commands merely to match their feature
count. Priority remains precise graph intelligence, lexical and optional
semantic retrieval, impact, trace, observability, and MCP integration.

## Current functionality that must be preserved

### Parsing / indexing

- Node.js + TypeScript
- Tree-sitter
- incremental file hashing
- graph index versioning
- vector index versioning
- transactional SQLite graph writes
- copy-on-write vector generation semantics
- changed / added / deleted file handling
- dependency-aware impacted-file rebuilds

### Graph

Node types:

- file
- function
- class
- method
- variable
- interface
- type
- enum

Edge types:

- contains
- imports
- calls
- extends

Resolution already supports:

- direct local calls
- imported calls
- `new Class().method()`
- `this.method()`
- typed parameters
- class fields
- constructor parameter properties
- local/imported inheritance
- stable qualified symbol identity
- bounded graph expansion

### Retrieval

- local embeddings
- optional local vector search
- lexical search
- vector search
- RRF fusion
- reranker
- graph expansion
- context budgeting
- optional external/host LLM generation consumer (llama.cpp/OpenAI-compatible)

### UI

- Overview
- Retrieval Inspector
- vector / lexical / fusion / rerank stages
- graph provenance
- retrieval-only vs retrieval+graph comparison
- exact final context
- exact prompt/messages
- Graph Explorer
- global graph
- file tree
- code inspector
- Sigma.js + Graphology
- focus/highlight
- Force / Radial layouts

### CLI

The current CLI progress presentation is considered **done**.

Must preserve:

- `listr2`
- custom theme/colors
- icons
- progress bars
- `ProgressReporter`
- TTY / non-TTY rendering
- `NO_COLOR`
- concise error presentation while preserving stack traces

Future refactors must adapt core progress events to this layer, not replace it.

---

# Target architecture

```text
source repository
        ↓
Index Pipeline
  ├─ scan
  ├─ hash
  ├─ structure
  ├─ parse
  ├─ resolve
  ├─ graph
  ├─ lexical
  ├─ optional semantic
  ├─ optional graph metrics
  └─ persist
        ↓
.codeatlas/atlas.db
        ↓
Core Services
  ├─ status
  ├─ search
  ├─ graph
  ├─ impact
  ├─ trace
  ├─ retrieval inspection
  └─ context building
        ↓
CLI / HTTP API / Web UI / MCP
        ↓
Optional enhancements
  ├─ EmbeddingProvider for Semantic Search
  └─ RerankerProvider for Reranking
```

## Shared-core adapter invariant

CLI, MCP, HTTP, and UI must reuse the same core services. Adapters may parse
inputs, construct dependencies, render results, and report errors, but they
must not duplicate indexing, search, graph, impact, trace, or retrieval logic.

```text
Core services
├─ CLI adapter
├─ MCP adapter
├─ HTTP adapter
└─ UI adapter
```

For example, `impact` has one core implementation reused by every adapter.

## Release invariants

1. Graph and lexical indexing work without Docker, model downloads, LLMs, external vector databases, or cloud services.
2. Optional capabilities degrade gracefully instead of crashing core operations.
3. Graph writes remain transactional.
4. Semantic replacement preserves the previous usable generation until a new generation is complete.
5. File freshness is explicit per capability and does not depend on whether vector points exist.
6. Zero-chunk files can still be fully processed and current.
7. Symbol resolution follows **unique-or-drop**.
8. Resolution ambiguity and unsupported dynamic behavior are surfaced as coverage/provenance data.
9. CLI business logic depends only on `ProgressReporter`, never `listr2`/`chalk`/terminal APIs.
10. CLI, HTTP, UI, and MCP call the same core services.
11. No adapter spawns `pnpm`, `tsx`, or a second indexer process.
12. No mandatory external infrastructure for the default public path.
13. Git metadata is an optional narrowing optimization; final freshness is verified with content hashes and filesystem checks.
14. CodeAtlas is not ready for public alpha until MCP is implemented and validated.

## Incremental correctness invariants

1. Full rebuild and incremental sync must converge to the same final indexed state.
2. Git-aware detection is an optimization only. Filesystem/content hashes remain the correctness authority.
3. Unchanged files must not lose graph, lexical, or semantic state.
4. A re-index/update of a file must replace that file's prior capability data deterministically.
5. If contradictory change signals occur for the same file in one sync cycle, replacement/update wins over accidental destructive deletion when the file still exists.
6. Deleted files must be reconciled consistently across applicable capabilities.
7. Unexpected unexplained index shrink must be detectable and must not silently corrupt state.
8. Orphaned generated/index records should be cleaned deterministically when their source file disappears.
9. Capability failures must not corrupt unrelated capability state.
10. Incremental logic must preserve existing semantic copy-on-write guarantees.

---

# Naming and public surface

## Naming set

```text
Product:        CodeAtlas
Repository:     code-atlas
CLI binary:     code-atlas
Local state:    .codeatlas/
Database:       .codeatlas/atlas.db
Environment:    CODEATLAS_*
MCP server:     code-atlas
UI branding:    CodeAtlas
```

## Current-repository CLI default

The repository path is optional. Commands operate on the current working
repository by default; an explicit path is only needed when targeting another
repository.

Preferred normal usage:

```bash
code-atlas init
code-atlas index
code-atlas sync
code-atlas status
code-atlas search "AuthService"
```

Explicit targeting remains available:

```bash
code-atlas index ../other-repo
```

Normal CLI usage must not require callers to pass `.` as the repository path.

The npm package name must be checked for availability before publishing. Do not hard-code a scoped package name until that check is done.

Example CLI:

```bash
code-atlas index
code-atlas sync
code-atlas status
code-atlas search "createPointId"
code-atlas graph callers createPointId
code-atlas inspect "where is createPointId used?"
code-atlas serve
code-atlas mcp
code-atlas init
code-atlas sync --skip-git
```

---

# Storage design

## Default

Use one per-repository database:

```text
<repo>/.codeatlas/atlas.db
```

Backed by built-in `node:sqlite`.

This becomes the local source of truth for:

- repository identity
- scanned files
- per-capability file state
- symbols
- graph edges
- chunks
- FTS5
- index versions
- index runs
- graph coverage
- optional graph metrics
- optional local vector state

## Proposed schema

```text
repositories
  id
  identity_key
  root_path
  display_name
  created_at
  updated_at

files
  repository_id
  path
  file_hash
  language
  parser_status
  indexed_at

file_capability_state
  repository_id
  file_path
  capability
  version
  state
  generation
  item_count
  last_error
  updated_at

symbols
  repository_id
  id
  type
  name
  qualified_name
  file_path
  start_line
  start_column
  end_line
  end_column

edges
  repository_id
  id
  from_symbol_id
  to_symbol_id
  type
  owner_file
  resolution_status

edge_evidence
  edge_id
  kind
  source
  target
  detail

chunks
  repository_id
  id
  file_path
  symbol_id
  content
  start_line
  end_line
  part
  total_parts
  generation_id

chunks_fts
  FTS5 virtual table over path, symbol name/type, chunk content

index_runs
  id
  repository_id
  status
  started_at
  completed_at
  error

index_versions
  repository_id
  axis
  version
  updated_at

graph_coverage
  repository_id
  file_path nullable
  resolved_calls
  unresolved_calls
  ambiguous_calls
  unresolved_extends
  parser_errors
  unsupported_dynamic_calls
  may_be_incomplete

graph_metrics
  repository_id
  symbol_id
  metric
  version
  value
  run_id

semantic_vectors
  optional provider-owned representation
```

### Why normalized capability state

Do not use fixed columns such as:

```text
graph_state
lexical_state
semantic_state
metrics_state
...
```

Instead:

```text
file_capability_state
```

with one row per file/capability.

Example:

```text
store.ts | graph    | 1.1.0         | ready | ...
store.ts | lexical  | 1.0.0         | ready | ...
store.ts | semantic | minilm@1.0.0   | ready | 0 items
```

This naturally handles new capabilities later without schema-column growth.

---

# Index version model

Replace the mental model of one or two global versions with independent axes.

Conceptually:

```ts
type IndexVersions = {
  schema: string;
  parser: string;
  graph: string;
  lexical: string;
  semantic?: string;
  metrics?: string;
};
```

Rules:

```text
schema change
→ run migration or invalidate store

parser/chunk extraction semantics change
→ rebuild affected structural/chunk outputs

resolver/graph semantics change
→ graph rebuild

FTS tokenizer/ranking/index format change
→ lexical rebuild

embedding model/dimension/vector semantics change
→ semantic rebuild only

PageRank/community algorithm change
→ metrics rebuild only
```

Do not rebuild unrelated capabilities when only one axis changes.

Existing development constants remain untouched until the migration phase that replaces them.

---

# Repository identity

Current basename-only identity is not public-safe.

These must not collide:

```text
/a/foo
/b/foo
```

Target strategy:

1. Each `.codeatlas/atlas.db` persists a repository UUID.
2. Also persist a canonical-path-derived `identity_key`.
3. On first initialization:
   - resolve `realpath` when possible
   - normalize platform-specific path representation
   - hash canonical path with an identity-format version
   - create repository UUID
4. If the repository directory moves together with `.codeatlas/atlas.db`, prefer the persisted UUID and update path metadata explicitly.
5. Never silently reuse old basename-only vector/index state.

---

# Provider architecture

Public/configurable provider boundaries are feature-first and intentionally
small. The CodeAtlas core/provider roadmap exposes only `EmbeddingProvider`
and `RerankerProvider`.

## EmbeddingProvider

```ts
type EmbeddingProvider = {
  readonly id: string;
  readonly dimensions: number;

  isAvailable(): Promise<boolean>;

  embedBatch(texts: string[]): Promise<number[][]>;
};
```

## VectorStore

`VectorStore` is an internal storage abstraction only. It is not a public
addon or configuration surface.

```ts
type VectorStore = {
  readonly id: string;

  status(repositoryId: string): Promise<ProviderStatus>;

  search(
    repositoryId: string,
    vector: number[],
    limit: number,
  ): Promise<SearchResult[]>;

  stageGeneration(input: StageGenerationInput): Promise<StagedGeneration>;

  activateGeneration(generationId: string): Promise<void>;

  discardGeneration(generationId: string): Promise<void>;
};
```

## RerankerProvider

```ts
type RerankerProvider = {
  readonly id: string;

  isAvailable(): Promise<boolean>;

  rerank(
    query: string,
    candidates: SearchResult[],
    limit: number,
  ): Promise<SearchResult[]>;
};
```

Users should not choose between vector databases or implementations. CodeAtlas
selects and ships one built-in local vector backend: SQLite BLOB storage with
application cosine search. The internal `VectorStore` seam exists for
separation of concerns, testability, implementation replacement, and migration
safety; it is not a product configuration surface.

Semantic Search requires an `EmbeddingProvider` and the built-in internal
`VectorStore` backend. Users should normally only choose or configure the
`EmbeddingProvider`. Possible categories include a built-in/local embedding
model, an OpenAI-compatible embedding API, and future compatible providers;
the public provider set remains intentionally open until explicitly decided.

### Current module mapping

```text
src/lib/embedding.ts
→ local Transformers.js EmbeddingProvider

src/lib/reranker.ts
→ optional local cross-encoder RerankerProvider

src/lib/llama.ts
→ standalone/external LLM consumer, outside the CodeAtlas core provider model
```

Any `llama.cpp` or OpenAI-compatible LLM client remains a standalone/external
consumer configuration, not a CodeAtlas core provider dependency.

---

# Local vector strategy

Phase 6 selected and shipped one built-in local vector backend for CodeAtlas:
SQLite BLOB storage with application cosine search. This is an implementation
decision, not a user-selectable backend marketplace. Keep the internal
`VectorStore` seam for lifecycle and migration safety.

Candidates:

| Option                           | Benefits                            | Risks                                      | Decision      |
| -------------------------------- | ----------------------------------- | ------------------------------------------ | ------------- |
| SQLite + application cosine scan | Zero extra service/native extension | O(n) query, memory/deserialize cost        | Selected      |
| sqlite-vec                       | Better local vector querying        | Native distribution/ABI/package complexity | Spike         |
| Local HNSW library               | Fast local ANN                      | Another index format/dependency            | Spike         |

Benchmark record for the selected CodeAtlas semantic backend:

```text
1k chunks
10k chunks
50k chunks
100k chunks
```

Measure:

- index time
- query latency
- memory
- DB/index size
- packaging complexity
- macOS/Linux/Windows behavior

Graph + FTS5 remain the public default regardless of this decision.

The chosen backend must be local-first, persistent, require no mandatory
daemon or Docker, suit repository-scale semantic search, integrate cleanly
with `.codeatlas/`, provide simple lifecycle and cleanup, isolate repositories
deterministically, support incremental semantic updates, and preserve the
existing copy-on-write guarantees where applicable. Legacy external-vector
metadata is stale and rebuilds into SQLite; it is not read as a live backend.

---

# Graph resolution v2

## Policy

**Unique-or-drop.**

If multiple plausible targets remain after applicable evidence, do not persist an edge.

Never turn a heuristic guess into a graph fact.

## Evidence model

Use structured evidence, not only string tags.

```ts
type ResolutionEvidenceKind =
  | "same_file"
  | "import_binding"
  | "this_receiver"
  | "constructor_type"
  | "parameter_type"
  | "field_type"
  | "inheritance";

type ResolutionEvidence = {
  kind: ResolutionEvidenceKind;
  source?: string;
  target?: string;
  detail?: string;
};
```

Example:

```json
[
  {
    "kind": "parameter_type",
    "source": "store",
    "target": "GraphStore"
  },
  {
    "kind": "import_binding",
    "source": "GraphStore",
    "target": "src/graph/store.ts"
  }
]
```

This provenance must later be consumable by:

- Inspector
- CLI
- MCP
- impact/trace

## Preserve successful current cases

- direct/local calls
- imported calls
- `new Class().method()`
- `this.method()`
- typed parameter receivers
- typed class fields
- constructor parameter properties
- local/imported inheritance

Do not expand into arbitrary JS/TS type checking during this migration.

---

# Coverage semantics

Avoid claiming `"complete"` for lightweight JS/TS static analysis.

Use measurable signals.

```ts
type GraphCoverage = {
  resolvedCalls: number;
  unresolvedCalls: number;
  ambiguousCalls: number;
  unresolvedExtends: number;
  parserErrors: number;
  unsupportedDynamicCalls: number;
  mayBeIncomplete: boolean;
};
```

Optional UI/API classification may be:

```text
supported
partial
unknown
```

but numeric evidence is the source of truth.

`mayBeIncomplete` becomes true when there are:

- unresolved imports
- parser failures
- unsupported dynamic dispatch
- dropped ambiguity
- unsupported syntax/resolution cases

---

# Graph intelligence roadmap

## P0 — Impact

Input:

```text
symbol/file identity
direction
maxDepth
maxNodes
```

Output:

```text
affected nodes
affected edges
relation/evidence
bounds/truncation
coverage
```

Compute on demand initially.

## P0 — Trace

Input:

```text
source symbol
target symbol
maxDepth
allowed edge types
```

Output:

```text
ordered path
edge types
edge evidence
coverage
no-path / ambiguous / truncated status
```

Use deterministic shortest-path/BFS semantics initially.

## P1 — Importance

PageRank-like or equivalent structural importance.

Persist versioned metrics only after P0 correctness is stable.

## P1 — Communities

Add community grouping after graph correctness and impact/trace are stable.

Community IDs are not treated as public stable identity until stability is measured.

## P2 — Processes / flows

Later:

```text
entry point
→ ordered related graph steps
→ confidence/incomplete signals
```

Do not build CFG/PDG in this migration.

---

# Retrieval core

Keep four distinct responsibilities.

## `searchCode`

No LLM.

```text
lexical
+ optional semantic
→ optional hybrid/RRF
→ optional rerank
```

## `inspectRetrieval`

Returns stage-by-stage observability:

```text
lexical results
semantic results
fusion
rerank
graph expansion
provenance
timings
capabilities
context candidates
```

## `buildContext`

Only context assembly:

```text
ranked candidates
→ graph additions
→ dedupe
→ token budget
→ included/dropped chunks
→ exact rendered context
```

## `answerCodebase`

Optional standalone AI consumer:

```text
inspectRetrieval
→ buildContext
→ external/host LLM client
```

LLM availability is outside the CodeAtlas core capability model and is never
required for retrieval or MCP usage.

---

# Capability-aware degradation

Core should report capabilities independently.

Example:

```text
Graph:      ready
Lexical:    ready
Semantic:   not configured
Reranker:   not configured
Metrics:    unavailable
```

States should distinguish at least:

```text
ready
disabled
not_configured
unavailable
error
stale
```

Retrieval behavior:

```text
Lexical only
→ FTS5

Semantic only
→ EmbeddingProvider + built-in internal VectorStore

Hybrid
→ lexical + semantic → RRF

Rerank
→ only if configured

Graph expansion
→ structural graph

Standalone answer
→ only if an external/host LLM client is configured
```

Repository status also exposes the active change-detection mode:

```text
changeDetection: "git" | "filesystem"
```

# Standalone AI separation

Any future desktop, TUI, or chat answer experience is a separate consumer
layer over CodeAtlas core:

```text
Standalone UI/chat
├─ external/host LLM client
└─ CodeAtlas core
```

LLM reasoning, synthesis, and final user-facing answers stay with the host
agent or standalone consumer. They are not responsibilities of the
code-intelligence engine.

---

# Index pipeline

Do not big-bang unify orchestration before the stores/services are ready.

## Step 1: reusable domain services

First extract current executable logic into reusable services:

```text
indexGraph(...)
syncGraph(...)
indexSemantic(...)
syncSemantic(...)
repositoryStatus(...)
inspectRetrieval(...)
```

Old scripts become thin adapters.

They may temporarily still use:

```text
graph.db
index-metadata.db
legacy vector state is not read and is rebuilt into SQLite when needed
```

No behavior change yet.

## Step 2: AtlasStore

Introduce `.codeatlas/atlas.db`.

## Step 3: FTS5

Make graph + lexical zero-config.

## Step 4: Unified IndexPipeline

Only after AtlasStore + FTS5 exist, introduce:

```text
indexRepository(...)
syncRepository(...)
```

Conceptual phases:

```text
scan
→ hash
→ structure
→ parse
→ resolve
→ graph
→ lexical
→ optional semantic
→ optional metrics
→ persist
```

This avoids writing a unified orchestrator around storage that is immediately replaced.

---

# Progress integration

Keep the existing presentation exactly as a first-class contract.

```text
CLI listr2 renderer
        ↓
ProgressReporter
        ↓
Core services / IndexPipeline
```

Future adapters:

```text
MCP silent/structured reporter
        ↓
IndexPipeline

UI event reporter
        ↓
IndexPipeline
```

Core code must not import:

- `listr2`
- `chalk`
- `figures`
- `ora`
- terminal output APIs

The current colored/icon progress UX must not be removed or downgraded.

---

# Consistency and atomicity

## Structural + lexical

Write graph, lexical state, file state, and metadata through AtlasStore transactions.

Full rebuild:

```text
prepare/validate new state
→ BEGIN
→ replace affected committed state
→ update file capability states
→ COMMIT
```

Failure:

```text
ROLLBACK
→ previous committed index remains usable
```

## Semantic

Preserve current copy-on-write principle.

```text
prepare changed chunks
→ embed
→ write new generation
→ validate
→ activate new generation
→ retire old generation
```

If embedding/write fails:

```text
old generation remains active
```

If old-generation cleanup fails:

```text
new generation remains active
cleanup marked recoverable
```

Provider absence does not roll back graph/lexical indexing.

---

# Zero-chunk files

A file that produces no semantic chunks is still processed.

Example:

```text
web/vite.config.ts
hash = abc
semantic state = ready
item_count = 0
```

Next sync:

```text
same hash
+ semantic ready
+ 0 items
→ unchanged
```

Never infer freshness from:

```text
COUNT(vector points) > 0
```

Use explicit `file_capability_state`.

---

# AI Inspector

Preserve as a CodeAtlas differentiator.

It should visualize the actual capability state.

When everything is configured:

```text
Lexical
→ Semantic
→ Fusion/RRF
→ Rerank
→ Graph Expansion
→ Context Budget
→ Exact Context
→ Optional Answer
```

When semantic is absent:

```text
Lexical: ready
Semantic: not configured
Fusion: not applicable
Graph Expansion: ready
Context: ready
Standalone answer: external/host LLM not configured
```

No fake stages.

Preserve:

- retrieval-only vs retrieval+graph
- provenance
- dropped chunks
- exact final context
- exact prompt/messages
- timings
- graph view integration

---

# Graph Explorer

Preserve current GitNexus-inspired direction:

- global repo graph
- Global / Focused modes
- file explorer
- code inspector
- search focus instead of replacing full graph
- selected-neighborhood highlighting
- Sigma.js + Graphology
- deterministic Force / Radial layouts
- bounded graph views
- source synchronization

Graph Explorer reads the same structural index that CLI and MCP use.

---

# HTTP/API architecture

`src/server.ts` becomes a thin Inspector/API adapter over core services.

Core readiness must not depend on optional providers.

For example `/health` should conceptually return:

```json
{
  "core": "ready",
  "graph": "ready",
  "lexical": "ready",
  "semantic": "not_configured",
  "reranker": "not_configured"
}
```

Browser never reads:

- SQLite directly
- filesystem directly

---

# MCP target

Implement only after core contracts stabilize.

MCP mirrors CodeAtlas code-intelligence capabilities, not every local
administrative CLI command.

Planned intelligence tool surface:

```text
repository_status
search_code
get_symbol
find_callers
find_callees
find_imports
find_imported_by
impact
trace
inspect_retrieval
```

Keep `index_repository` and `sync_repository` as valid MCP tools where
available. They should use the current or registered repository context by
default; normal host-agent usage must not require passing `"."` as a path.

After the graph-intelligence phases, consider:

```text
list_communities
get_community
important_symbols
architectural_bridges
find_cycles
```

Local and administrative commands generally should not require MCP equivalents:

```text
init
clean
doctor
configure
ui
serve
hook install
hook uninstall
hook status
export commands
```

MCP exposes structured repository intelligence and useful indexing operations,
not local process or UI administration. Prefer `search_code`, `get_symbol`,
`impact`, and `trace` over a generic internal `ask_codebase` tool. The host
agent/LLM performs reasoning and answer synthesis; CodeAtlas remains the
structured code-intelligence layer.

`ask_codebase` is not a required core or MCP capability. If retained later, it
is optional standalone AI UX over structured CodeAtlas retrieval and an
external/host LLM client.

Responses should expose when relevant:

- repository identity
- bounds
- truncation
- capability state
- resolution evidence
- coverage metrics
- provenance
- provider failures

MCP uses the same core services as CLI/UI and never spawns the CLI.


# Agent integration and init target

The design contract for `code-atlas init` can be documented before its
implementation, but implementation waits until MCP and the shared core
capability contracts stabilize. It belongs after Phase 10 so generated agent
guidance can describe the same real capabilities exposed by the core and MCP;
it is not an early indexing dependency.

`code-atlas init` will:

- initialize repository metadata/configuration
- prepare `.codeatlas/`
- ensure the two-layer Git ignore contract when Git integration is applicable
- optionally add or refresh CodeAtlas instructions in `AGENTS.md`
- avoid building the full index unless a later, explicit design adds that behavior

## Two-layer local-state ignore contract

`.codeatlas/` is runtime/generated/local state. It must not contain
configuration that users are expected to commit or share.

Primary protection:

```text
repo-root/.gitignore
  .codeatlas/
```

When Git integration is applicable, `code-atlas init` must idempotently ensure
the repository-root `.gitignore` contains the `.codeatlas/` rule. If the file
does not exist, create it. If an equivalent rule already exists, do not
duplicate it. Preserve all existing user rules, comments, and content, and
append only the minimal missing rule. Refresh and repeated init must remain
idempotent.

Defensive protection:

```text
.codeatlas/.gitignore
  *
  !.gitignore
```

When `.codeatlas/` is created, also create the minimal managed
`.codeatlas/.gitignore` with those semantics. It protects generated files if
the root rule is later removed or the state directory is moved/copied. The
root rule is authoritative for hiding the entire CodeAtlas state directory
from normal Git status; the nested file is defensive only.

Do not create per-subfolder rules such as `.codeatlas/cache/`,
`.codeatlas/tmp/`, or `.codeatlas/logs/`; the whole generated state directory
is already protected. If the repository is not a Git repository, init must not
fail because root Git ignore setup is unavailable; the defensive file remains
local state protection when `.codeatlas/` is created.

If CodeAtlas later needs repository-tracked public configuration, use a
separate root-level public config file, such as a future `codeatlas.config.json`
or another explicitly chosen filename. The exact public config filename is not
decided by this contract.

The managed block is bounded by:

```text
<!-- codeatlas:start -->
...generated, capability-aware instructions...
<!-- codeatlas:end -->
```

The init/update flow must be idempotent, preserve all unrelated
`AGENTS.md` content, work whether the file exists or not, and update only the
CodeAtlas-managed block. A later refresh updates that block from actual
`repository_status` data; a later removal deletes only that block.

Generated guidance advertises only capabilities that are actually ready,
including `repository_status`, `search_code`, `get_symbol`, `find_callers`,
`find_callees`, `find_imports`, `find_imported_by`, `impact`, `trace`, and
`inspect_retrieval` when supported. `ask_codebase` is not part of the required
CodeAtlas capability set. Any repository/index summary—symbols,
relationships, capability readiness, and stale/fresh state—comes from actual
CodeAtlas status rather than hardcoded values.

Agent guidance is risk-aware: recommend impact before changing shared/public
symbols, signatures, data models, renames, deletions, or structural refactors;
recommend callers/callees/trace inspection for unfamiliar paths; and warn when
coverage may be incomplete. It must not require graph analysis for every tiny
edit.

---

# CLI contract

The initial/core CLI capability surface is organized by user intent. These
names define the target product contract; all commands need not exist
immediately.

Repository lifecycle:

```text
init
index
sync
status
clean
doctor
```

Code intelligence:

```text
search
symbol
callers
callees
imports
imported-by
impact
trace
inspect
```

Runtime and integration:

```text
mcp
serve
ui
```

Optional/local management, when implemented:

```text
configure
hook install
hook uninstall
hook status
```

Graph-intelligence commands are post-Phase-9 additions and should reuse the
shared graph-intelligence core services:

```text
communities
community
important
bridges
cycles
```

The exact grouping and spelling may evolve, but these commands must not create
parallel graph behavior.

---

# Multi-repository registry

Later phase only.

Concept:

```text
~/.codeatlas/registry.json
```

Each repository still owns:

```text
<repo>/.codeatlas/atlas.db
```

Registry entry:

```text
repository UUID
canonical path
display name
last seen
```

Support:

- list known repos
- explicit selection
- moved/missing repo state
- same-basename repos safely

The later CLI surface may add `repos` or `list`, repository groups (or an
equivalent repository-set concept), and cross-repository query, trace, and
analysis commands. Exact syntax remains flexible until the registry contract
is finalized. Do not copy GitNexus command naming blindly.

Do not make registry a prerequisite for single-repo core.

---

# Current → target map

| Current module                        | Responsibility today                     | Target direction                                                  |
| ------------------------------------- | ---------------------------------------- | ----------------------------------------------------------------- |
| `src/index-graph.ts`                  | Graph executable orchestration           | Thin CLI adapter → graph service → unified pipeline later         |
| `src/embed-repo.ts`                   | Semantic executable orchestration       | Thin adapter → semantic service/provider → unified pipeline later |
| `src/build-graph.ts`                  | Full graph CLI                           | Graph service/adapter                                             |
| `src/query-graph.ts`                  | Direct graph query CLI                   | Core graph query + CLI adapter                                    |
| `src/ask-rag.ts`                      | Retrieval + generation script            | Thin adapter over `inspectRetrieval` / `answerCodebase`           |
| `src/graph/store.ts`                  | Graph-only SQLite                        | `AtlasStore`                                                      |
| `src/services/index-metadata.ts`      | Separate metadata DB                     | `AtlasStore` versions/index runs                                  |
| `src/services/index-state.ts`         | Vector-derived freshness                 | `file_capability_state`                                           |
| `src/services/lexical-search.ts`      | Prior vector-scan lexical                | FTS5 lexical core                                                 |
| `src/services/code-search.ts`         | Embedding + vector query                | Semantic search over providers                                    |
| `src/services/hybrid-search.ts`       | vector + lexical + RRF                   | capability-aware fusion                                           |
| `src/services/retrieval-inspector.ts` | Inspector orchestration                  | Core retrieval inspection                                         |
| `src/lib/embedding.ts`                | local embedder                           | `EmbeddingProvider`                                               |
| `src/lib/reranker.ts`                 | local reranker                           | optional `RerankerProvider`                                       |
| `src/lib/llama.ts`                    | llama/OpenAI-compatible client           | standalone/external LLM consumer                                 |
| `src/cli/progress.ts`                 | listr2 progress renderer                 | **Keep**                                                          |
| `src/cli/theme.ts`                    | CLI colors/theme                         | **Keep**                                                          |
| `src/cli/format.ts`                   | icons/bars/formatting                    | **Keep**                                                          |
| `src/cli/types.ts`                    | progress contract                        | **Keep / extend only if needed**                                  |
| `src/server.ts`                       | API wiring                               | thin Inspector/API adapter                                        |
| `web/`                                | AI Inspector + Graph Explorer            | preserve and make capability-aware                                |

---

# Migration strategy

Use an incremental strangler migration.

Do not big-bang rewrite.

Old entrypoints remain valid until new service equivalents pass tests.

---

# Phase 0 — Baseline and permanent gates

## Status

Complete.

## Goal

Freeze current working behavior before architecture migration.

## Add permanent tests for

Graph resolution:

```text
local call
imported call
this.method()
new Class().method()
typed parameter
class field
constructor parameter property
extends local
extends imported
stable qualified identities
nested-scope duplicate avoidance
```

Correctness:

```text
ambiguous candidate fixture
zero-chunk file
deleted file
changed file
graph transactional rollback
vector copy-on-write
version mismatch
```

Product contracts:

```text
Inspector exact-context fidelity
retrieval-only vs retrieval+graph
CLI progress formatting
NO_COLOR
non-TTY rendering
```

## No implementation architecture changes

No AtlasStore.
No provider migration.
No rename.
No MCP.

## Completion

All existing tests remain green and missing v2 invariants have explicit regression fixtures.

---

# Phase 1 — Extract reusable domain services

## Status

Complete.

## Goal

Move business logic out of executable scripts without changing storage.

Introduce reusable functions such as:

```text
indexGraph(...)
syncGraph(...)
indexSemantic(...)
syncSemantic(...)
repositoryStatus(...)
inspectRetrieval(...)
answerCodebase(...)
```

Old entrypoints become thin adapters.

## Keep current storage temporarily

```text
graph.db
index-metadata.db
```

## Preserve CLI progress

Scripts still use the current listr2 UI through `ProgressReporter`.

## No version bump

This phase should be behavior-preserving.

---

# Phase 2 — Unified AtlasStore

## Status

Complete.

## Goal

Introduce:

```text
.codeatlas/atlas.db
```

Implement:

- repository identity
- files
- normalized file capability state
- symbols
- edges
- chunks
- versions
- index runs
- coverage
- transactional graph persistence

Do not silently migrate `.code-rag`.

## Tests

- create/reopen DB
- transaction rollback
- zero-chunk file state
- same-basename repositories
- changed/deleted files
- repository move behavior
- schema versioning

---

# Phase 3 — FTS5 lexical core

## Status

Complete.

## Goal

Make CodeAtlas useful with no optional providers.

```bash
code-atlas index
code-atlas search
```

must work using:

```text
Tree-sitter
Graph
SQLite
FTS5
```

No external vector service call.

## Tests

- exact symbol match
- filename match
- source-content match
- ranking
- deterministic tie ordering
- changed/deleted rows
- empty query
- no external vector service/model available

---

# Phase 4 — Unified IndexPipeline

## Status

Complete.

## Goal

Now that AtlasStore + FTS5 exist, unify repository orchestration.

Introduce:

```text
indexRepository(...)
syncRepository(...)
```

Pipeline:

```text
scan
→ hash
→ structure
→ parse
→ resolve
→ graph
→ lexical
→ optional semantic
→ optional metrics
→ persist
```

## Progress

```text
CLI listr2
→ ProgressReporter
→ IndexPipeline
```

Keep the current colored/icon progress UX.

## Git-aware change detection

Git is an optional optimization layer for `syncRepository(...)`, never a hard
dependency or the final freshness authority.

When the requested repository is inside a Git worktree and Git is available:

1. Detect the repository root.
2. Use Git metadata to narrow eligible modified, added, deleted, and untracked
   paths to the existing CodeAtlas indexing scope.
3. Re-check relevant filesystem paths and content hashes before committing
   index state. Confirm Git-reported deletions against the filesystem.
4. Fall back to a broader filesystem scan whenever Git cannot establish a
   complete, trustworthy candidate set.

Ignored/generated metadata is advisory to narrowing; CodeAtlas's indexing
scope remains the eligibility authority. Symlinks, path normalization, and
scope boundaries must be validated before state is committed. Unresolved edge
cases force filesystem/hash verification rather than silently changing
freshness. Candidate paths and committed updates are processed in deterministic
order, and Git status is never trusted without hash verification.

For non-Git repositories, or when `--skip-git` is supplied, use filesystem scan
plus content hashing. `repository_status` reports
`changeDetection: "git" | "filesystem"`, and the Git and filesystem paths must
produce the same final index for the same source tree.

## Tests

- Git modified file
- Git added file
- Git deleted file
- eligible untracked file
- no-Git filesystem fallback
- `--skip-git`
- Git narrowing followed by content-hash verification
- identical final index result through Git and filesystem detection
- ignored/generated/symlink/path edge cases do not corrupt freshness

## Completion

CLI/API call one orchestration path instead of separate graph/vector scripts.

Phase 4 established unified repository indexing/sync orchestration with
Git-aware change candidates, filesystem fallback, content-hash verification,
`skipGit`, and `changeDetection: "git" | "filesystem"`. Renames are handled
conservatively as delete plus add, with deterministic repository-relative
paths. Git is an optimization only; filesystem and content state remain the
correctness authority.

---

# Phase 5 — Provider boundaries and capability model

## Status

Complete.

Phase 5 established optional `EmbeddingProvider` and `RerankerProvider`
boundaries, kept `VectorStore` internal, and normalized capability readiness
without adding an LLM provider or user-selectable vector backends.

## Goal

Move concrete optional dependencies behind:

```text
EmbeddingProvider
RerankerProvider
```

`VectorStore` remains an internal storage abstraction only. It is not a
public provider choice or configuration surface. CodeAtlas ships one built-in
local vector backend selected in Phase 6; users should not choose between
vector databases or implementations.

Feature-first configuration is:

```text
Core
├─ Graph
└─ Lexical / FTS5

Optional Semantic Search
└─ EmbeddingProvider

Optional Reranking
└─ RerankerProvider
```

Semantic Search requires an `EmbeddingProvider` plus the built-in internal
`VectorStore` backend. The user normally configures only the embedding
provider. CodeAtlas is a code-intelligence engine, not a chat or agent
runtime; host agents perform reasoning through MCP, and CodeAtlas must not
require an internal LLM for MCP usage. `ask_codebase` is not a required
core/MCP capability.

Add capability statuses:

```text
ready
disabled
not_configured
unavailable
error
stale
```

Core health must remain ready when optional providers are absent.

## No provider required by default

No external vector database.
No embedding model.
No reranker model.
No LLM.

---

# Phase 6 — Optional semantic/vector indexing

## Status

Complete.

## Goal

SQLite BLOB storage with application cosine search is the sole built-in vector
backend for optional Semantic Search. This is not a user-selectable
vector-backend marketplace.

Benchmark candidates may include:

- SQLite BLOB + cosine
- sqlite-vec
- local HNSW

The benchmark exists to choose one backend for CodeAtlas, not to expose all
candidates as product configuration.

Preserve:

- local Transformers embeddings
- cross-encoder reranker
- copy-on-write generation safety

Implement explicit semantic file state including zero chunks.

The chosen backend must be local-first, persistent, require no mandatory
daemon or Docker, suit repository-scale semantic search, integrate cleanly
with `.codeatlas/`, provide easy lifecycle and cleanup, isolate repositories
deterministically, support incremental semantic updates, and remain compatible
with existing copy-on-write guarantees where applicable. Legacy external-vector
metadata is stale and rebuilds into SQLite; it is not read as a live backend.

## Completion

Lexical-only works with no provider.

Configured semantic search works with the selected provider.

The implementation lives in `src/storage/atlas/sqlite-vector.store.ts` and
requires no external vector service or Docker runtime.

---

# Phase 7 — Resolution evidence and coverage

## Status

Complete.

## Goal

Convert existing resolution into precision-first, explainable resolution.

Implement:

```text
candidate generation
→ evidence application
→ unique target?
   yes → edge
   no  → drop + coverage
```

Persist structured evidence.

Expose numeric coverage.

## Intentional correctness change

Ambiguous current first-match edges may disappear.

This requires the graph/pipeline version bump appropriate to the new version-axis system.

Graphify is design inspiration for evidence and confidence concepts such as
`EXTRACTED`, `INFERRED`, `AMBIGUOUS`, confidence scores, and source evidence.
CodeAtlas should define its own structured resolution evidence around:

- `evidenceKind`
- `resolutionMethod`
- source file/location
- target symbol identity
- confidence when useful
- ambiguity reason
- resolver diagnostics
- coverage metrics

Keep these resolution methods: `same_file`, `import_binding`,
`this_receiver`, `constructor_type`, `parameter_type`, `field_type`, and
`inheritance`.

The hard rule remains **precision-first / unique-or-drop**. Confidence must
not authorize speculative call edges. Low-confidence or ambiguous resolution
is dropped or surfaced as unresolved/ambiguous evidence rather than silently
becoming a structural edge. Coverage continues to include resolved calls,
unresolved calls, ambiguous calls, unresolved extends, parser errors,
unsupported dynamic cases, and `mayBeIncomplete`.

---

# Phase 8 — Impact and trace

## Status

Complete.

## Goal

Add the first high-value graph intelligence features.

### Impact

```text
what is affected if X changes?
```

### Trace

```text
how does A reach B?
```

Compute on demand.

Deterministic and bounded.

No graph database required.

Graphify query, path, and explain UX is design inspiration. CodeAtlas keeps
these user intents distinct:

- search
- explain/get symbol
- trace/path
- impact/blast radius

Plan a `GraphQueryEntityResolver` for user-facing symbol lookup. It is
separate from AST resolver logic and may rank candidates by exact qualified
name, exact symbol name, exact normalized token, prefix, lexical relevance,
file/path context, and symbol kind/context. It must avoid selecting a weak
endpoint and then falsely reporting that no path exists.

Trace/path should return an understandable traversal, preserve edge direction,
show relation types, and include evidence where useful. Impact is not generic
shortest-path behavior: preserve CodeAtlas callers/callees/import/imported-by
and blast-radius semantics with structured risk output.

---

# Phase 9 — Importance and communities

## Status

Next; not started.

## Goal

Add optional structural metrics.

- PageRank-like importance
- community detection

Persist versioned metrics.

Do not make metrics required for graph/search readiness.

Graphify community analysis is design inspiration for symbol importance,
community assignment, stable community identity where practical, community
metadata, `list_communities`, `get_community`, and Graph Explorer
visualization.

### Hub / noise suppression

Importance ranking must avoid meaningless dominant nodes such as built-in or
common runtime symbols, framework boilerplate, synthetic file hubs, trivial
generated symbols, and mechanically high-degree noise. Presented importance
must not rely on raw degree or PageRank alone.

### Oversized community handling

If a community becomes too broad to be useful, allow recursive/safe splitting
or an equivalent refinement while keeping output deterministic and stable
where practical. Keep the algorithm choice open unless explicitly fixed
elsewhere; NetworkX is not required.

### Architectural bridges

Add a future analysis concept for architectural bridges or cross-subsystem
couplings, including cross-community bridges, cross-subsystem coupling,
peripheral-to-hub dependencies, and structurally surprising dependencies.

---

# Phase 10 — MCP adapter

## Goal

Expose core services via MCP.

Target architecture:

```text
Host agent / host LLM
        ↓
       MCP
        ↓
CodeAtlas structured intelligence tools
```

The host model owns reasoning, synthesis, and final user-facing answers.
CodeAtlas does not require an internal LLM provider for this flow.

No duplicate business logic.

No CLI spawning.

Use silent/structured progress.

Test contract parity between MCP and core services.

---

# Phase 11 — Agent Integration and init workflow

## Status

Planned after Phase 10.

## Goal

Implement the documented `code-atlas init` contract after MCP capability
contracts are available.

Implement:

- repository metadata/config initialization
- `.codeatlas/` preparation
- idempotent root `.gitignore` setup with minimal append-only preservation
- creation of the defensive `.codeatlas/.gitignore` with `*` and `!.gitignore`
- no per-subfolder ignore rules
- optional, idempotent CodeAtlas block management in `AGENTS.md`
- capability-aware instruction generation from actual repository status
- refresh/update and managed-block-only removal

Do not build the full index automatically from `init` without an explicit later
design decision.

## Tests

- existing `AGENTS.md` content remains byte-for-byte unchanged outside the managed block
- missing `AGENTS.md` is created safely when integration is selected
- repeated init/refresh does not duplicate or reorder the managed block
- removal deletes only the managed block
- root `.gitignore` missing is safely created with `.codeatlas/`
- existing root `.gitignore` content and comments are preserved
- existing `.codeatlas/` does not cause a duplicate root ignore rule
- repeated init remains idempotent for both ignore layers
- `.codeatlas/.gitignore` is created with exactly the defensive generated-state semantics
- defensive ignore content protects generated files while allowing `.gitignore`
- AGENTS.md managed-block removal/refresh does not remove either Git ignore protection
- unavailable capabilities are omitted from the structured CodeAtlas surface
- generated summary reflects actual symbols, relationships, readiness, and stale/fresh state
- `.codeatlas/` ignore setup is idempotent
- `init` does not build the full index by default
- non-Git repositories do not fail because Git-specific root ignore setup is unavailable

This phase follows MCP because the generated guidance must consume stabilized
core/MCP capability contracts instead of inventing a parallel agent API.

### Platform-aware installation

Graphify is inspiration for platform-aware installation. Future targets may
include Codex, OpenCode, Claude Code, and generic Agent Skills-compatible
environments. Alpha need not require every platform, and the design must not
hard-code architecture around one assistant.

### Optional refresh hooks

Potential future commands:

```text
code-atlas hook install
code-atlas hook uninstall
code-atlas hook status
```

Potential hooks are `post-commit` and `post-checkout`. Hooks are optional,
require no daemon or background service, reuse `IndexPipeline`, and use
read-only Git inspection except when installing or removing CodeAtlas-owned
hook integration. They must coexist safely with existing hooks, never corrupt
repository state on failure, and never become correctness dependencies.

### Optional strict agent mode

The default remains soft graph-aware guidance. A future strict graph-first
first-read behavior is opt-in only, must provide escape and fallback behavior,
must not trap agents in a loop, and must not prevent direct source inspection
when graph capability is unavailable, stale, or incomplete.

Do not implement hooks or strict mode now.

# Future capability — Project Memory

Project Memory is a later, repository-scoped capability for durable knowledge
about why the codebase is designed as it is. It records architecture and
technical decisions, constraints, conventions, known issues, milestones, and
important project context. It is not a transcript archive or raw conversation
and session logger.

Do not store raw user messages, assistant messages, tool calls, or full agent
session logs as the memory model. Those inputs create storage growth, noisy
context, secret and privacy risk, stale information, poor reuse quality, and
duplication. Project Memory should contain normalized, durable, attributable
facts instead.

## Storage direction

Project Memory should eventually live in the repository's existing
`.codeatlas/atlas.db`. A future conceptual model is:

```text
project_memories
├─ id
├─ repository_id
├─ kind
├─ title
├─ content
├─ source / provenance
├─ confidence (optional)
├─ created_at
├─ updated_at
└─ superseded_by
```

The exact schema is a future implementation detail; no schema is added by
this plan update.

Initial taxonomy should remain small:

```text
decision
architecture
constraint
convention
known_issue
milestone
```

Every memory item must retain provenance. Possible sources include an explicit
user or agent record, repository-derived facts, Git or commit history,
CodeAtlas analysis, and imported project documentation. Memory must not become
an unattributed collection of free-form facts.

## Supersession and creation

Decisions can change. The model should support superseding an older item,
preserving its historical reason, identifying the current active item, and
avoiding silent history overwrite. For example, a decision that Qdrant was the
semantic backend could be superseded by the current decision that SQLite BLOB
plus cosine is the sole VectorStore backend.

Future creation modes may include:

- explicit records such as `code-atlas memory add ...`
- repository-derived memories from significant architectural changes,
  conventions, or plan/ADR data
- agent-authored records through MCP, potentially with tools such as
  `get_project_memory`, `search_project_memory`,
  `record_project_decision`, and `supersede_project_memory`

The final MCP tool contract is intentionally not defined yet. Agent-authored
memory must not become permanent through blind append; validation rules are
required before durable acceptance.

## Retrieval and quality rules

Project Memory should eventually support exact/category lookup, lexical search,
optional semantic search, and MCP access. Retrieval must be deterministic,
bounded, repository-isolated, and avoid injecting unbounded memory into an
agent context. Future implementation must also address deduplication,
supersession, secret and sensitive-data avoidance, and stale or conflicting
records.

Project Memory becomes a first-class cross-agent capability only after MCP and
Agent Integration exist. It should remain repository-scoped first; groups and
cross-repository memory may be considered only after the multi-repository
registry exists. Standalone desktop or chat consumers, if added later, remain
separate consumer layers over CodeAtlas core and an external or host LLM.

Examples:

```text
decision: SQLite BLOB + cosine is the sole VectorStore backend.
reason: Selected after the Phase 6 benchmark for zero-daemon persistence and
        the lowest cross-platform packaging risk.

architecture: Graph resolution uses precision-first unique-or-drop.
reason: Ambiguous structural relationships must not create speculative edges.
```

Do not implement Project Memory in the current phase.

---

# Post-alpha / future backlog

These ideas are not required for the initial public alpha and remain
documentation-only until their owning phases are explicitly started.

## PR graph intelligence

Potential future capability:

- map changed files and symbols in a PR
- compute affected graph communities
- compare overlap between active PRs
- expose potential merge, conflict, and risk areas
- summarize blast radius

This may integrate with GitHub later, but GitHub must not become a core
dependency.

## Architecture / callflow export

Potential future exports include Mermaid, architecture maps, and call-flow
diagrams. Use existing CodeAtlas graph data; do not introduce a second graph
model for export.

## Local query telemetry

Potential opt-in local metrics include query intent, strategy used, capability
used, candidate count, latency, result count, and retrieval-stage timing.
Telemetry is opt-in and local-first, with no raw source/code logging by
default. It should support retrieval benchmarking and Inspector diagnostics.

Do not implement telemetry now.

---

# Phase 12 — Multi-repository registry

## Goal

Support multiple known repositories cleanly.

Use a global lightweight registry while keeping each repo index local.

No basename collision.

---

# Phase 13 — CodeAtlas rename and packaging

## Goal

Perform the naming migration only after core architecture is stable.

Rename together:

```text
project branding → CodeAtlas
repository → code-atlas
binary → code-atlas
state dir → .codeatlas
env prefix → CODEATLAS_
MCP name → code-atlas
UI branding → CodeAtlas
```

Public package:

```json
{
  "bin": {
    "code-atlas": "./dist/cli.js"
  }
}
```

No runtime `tsx`.

No hard-coded development paths.

## Required packaging test

```text
pnpm pack
→ install tarball in clean temp project
→ cd another-repo
→ code-atlas index
→ code-atlas status
→ code-atlas search
→ code-atlas serve
```

All must work without Docker, external vector databases, or LLMs.

---

# Phase 14 — Clean-machine/public validation

Public alpha gate: CodeAtlas must not be considered ready until MCP is
implemented and validated.

Validate:

- macOS
- Linux
- Windows
- Node 24
- supported lower/current LTS selected after spike

Matrix:

```text
Graph + lexical only
Optional local semantic
Legacy external-vector metadata is stale and rebuild-only
No LLM
Optional standalone external/host LLM consumer
Zero-chunk files
Changed files
Deleted files
Ambiguous resolution
Version invalidation
Inspector capability states
MCP
Package tarball
TTY/non-TTY/NO_COLOR
```

---

# Permanent test strategy

## Unit

- parser adapters
- stable identity
- resolver candidates/evidence
- unique-or-drop
- coverage
- FTS5 ranking
- RRF
- graph expansion
- impact/trace
- provider contracts
- context budget
- exact prompt rendering
- CLI formatting/progress

## Integration

Temporary fixture repository:

- initial index
- unchanged sync
- changed file
- deleted file
- importer impact
- zero chunks
- version mismatch
- ambiguous resolution
- transaction rollback
- DB reopen
- optional provider absent
- semantic generation failure/replacement/cleanup
- same-basename repos

## Contract

- Inspector reflects actual attempted/available stages
- exact final context equals LLM input
- health/status does not require optional providers
- CLI wrappers call services directly
- MCP later returns the same core result contracts

## Packaging

- packed npm tarball
- clean temporary installation
- another repository
- no dev absolute paths
- no runtime `tsx`
- no mandatory Docker, external vector database, or LLM
- supported OS/runtime matrix

---

# Performance gates

Capture a fixed baseline before Phase 1.

Record only measured values.

Track:

- graph nodes/edges
- graph coverage
- initial index wall time
- incremental sync wall time
- lexical query latency
- semantic query latency when enabled
- rerank latency
- graph expansion latency
- context assembly latency
- SQLite size
- semantic store size
- memory
- Graph Explorer render limits

For local vector spikes measure at:

```text
1k
10k
50k
100k chunks
```

Do not add a native vector dependency without measured need.

---

# Explicit non-goals

- full compiler/type checker
- CFG/PDG
- taint analysis
- arbitrary deep dynamic JS/TS resolution
- 100+ language support in v2
- Neo4j
- mandatory graph server
- mandatory Docker
- mandatory external vector database
- mandatory model download
- mandatory LLM
- mandatory cloud service
- rewriting core in Rust or Go
- big-bang rewrite
- removing/downgrading current CLI progress UI
- silently importing old `.code-rag` indexes
- public publishing before clean-package validation

---

# Recommended next action

Phase 8 is complete and green. The next planned implementation phase is:

**Phase 9 — Importance and communities.**

SQLite BLOB + cosine is the sole built-in vector backend; users do not select a
vector database. Agent integration and `code-atlas init` remain scheduled for
Phase 11, after MCP capability contracts stabilize. Project Memory remains a
later capability after MCP and Agent Integration; Phase 9 has not started.
