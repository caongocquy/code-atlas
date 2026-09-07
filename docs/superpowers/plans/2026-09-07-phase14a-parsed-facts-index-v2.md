# Phase 14A ParsedFacts and Index/Cache/Invalidation v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Introduce reusable path-neutral ParsedFacts, content-addressed fact caching, separated index version domains, dependency-aware incremental resolution, and atomic generation publication without changing Phase 13 semantics or implementing Resolver v2.

**Architecture:** The current graph, lexical, and semantic indexers will share one canonical Tree-sitter extraction result, persisted as an immutable ParsedFactsBlob and referenced by generation-scoped file bindings. An explicit invalidation plan will choose fact parsing, fact reuse, resolution, and derived work; the existing resolver will consume materialized facts and write a candidate generation before one SQLite transaction switches `active_generation_id`.

**Tech Stack:** Node.js >=22, TypeScript, SQLite, Tree-sitter, existing CodeAtlas infrastructure.

**Spec:** docs/superpowers/specs/2026-09-07-phase14a-parsed-facts-index-v2-design.md

## Global Constraints

- Planning scope is Phase 14A only. Do not implement Phase 14B or change resolver inference semantics.
- Keep Node >=22, TypeScript, the existing SQLite store, and the existing Tree-sitter adapters. Add no mandatory runtime service.
- ParsedFacts contains structural parser evidence only. Resolved targets, resolved edges, confidence, and resolver conclusions remain outside fact blobs.
- Keep fact blobs path-neutral; repository/path ownership belongs to `FileFactBinding`.
- Keep `factsSchemaVersion`, `factsVersion`, `parserIdentity`, `schemaVersion`, `resolutionVersion`, and `derivedVersion` as separate domains.
- Keep content hashes as the correctness source. Git status may remain only a candidate discovery optimization.
- Reuse the existing unique-or-drop resolver behavior. Do not add TypeEnvironment work, semantic invalidation, framework resolution, stable symbol identity redesign, embedding expansion, a native SQLite rewrite, a watcher, a daemon, or public fact/cache commands. Existing semantic indexing remains optional and must preserve its current enabled/disabled/unavailable capability semantics.
- Read-only Phase 13 commands remain non-mutating, including database, WAL/SHM, Git status/config, and repository timestamp behavior.
- Do not alter `package.json`; its existing dirty changes are unrelated and must remain unstaged.
- Every mutating lifecycle builds candidate state first, validates it, and publishes it atomically. A failed candidate leaves the active generation unchanged.
- Once the user explicitly authorizes execution of this plan, the task-scoped local commits described below are authorized. Never push, merge, or change branches unless separately authorized. `package.json` remains excluded unless a later Phase 14A change is separately justified and approved.

---

## Current implementation map

The current flow is:

```text
scanRepo / Git candidate hints
  -> filesystem-change-detector computes current hashes and added/changed/deleted paths
  -> graph-index.service reads each changed file
       -> parseCodeSymbols (Tree-sitter symbols)
       -> extractImports / extractImportBindings (regex import facts)
       -> extractCalls and hasParserErrors (additional Tree-sitter parses)
       -> member and extends extraction/resolution (additional Tree-sitter parses)
       -> existing resolver
       -> replaceGraph or applyFileUpdates in AtlasStore
  -> lexical-index.service independently reads files and calls parseCodeSymbols
       -> replaceLexicalDocuments in AtlasStore
  -> semantic-index.service independently reads files and calls parseCodeSymbols
       -> vector generation and semantic persistence
  -> index-pipeline.service closes each capability lifecycle
  -> sync/index wrappers expose the CLI and MCP lifecycle
```

- The symbol parse is in `src/core/graph/parsers/code-parser.ts`, while graph construction in `src/core/graph/build-graph.ts` and `src/core/graph/build-file-updates.ts` invokes separate call, member, parser-error, and extends parses. Lexical and semantic indexing invoke `parseCodeSymbols` independently. `src/core/change/transient-graph.ts` has its own source analysis for Phase 13 and is intentionally outside the Phase 14A indexing path.
- File hashes and capability state currently live in `files`/`file_capability_state` through `AtlasStore.getFileStates`, `setFileCapabilityState`, and the filesystem detector. Graph version decisions use `src/core/repository/index-version.ts` and `index_versions`; lexical and semantic versions are maintained in their respective services.
- Invalidation currently lives in `filesystem-change-detector.ts` for direct file changes and in `graph-index.service.ts` for direct importers found by querying the previously persisted graph. A missing or incompatible graph version selects a full rebuild; otherwise `applyFileUpdates` performs incremental graph writes.
- `AtlasStore` initializes schema in its mutating constructor and exposes separate transactions for `replaceGraph`, `applyFileUpdates`, and `replaceLexicalDocuments`. The current graph is loaded by repository, not by an active generation pointer, so these transactions do not yet share one candidate/publication boundary.
- Mutating repository access uses `ensureRepository`; `getRepositoryStatusReadOnly` uses `findRepository` and a read-only immutable store. The CLI status branch currently calls the mutating `getRepositoryStatus` and must be switched to the read-only wrapper as part of the read-only task.
- Phase 13 `readGraphDeltaContext`, `inspect_change`, `affected_tests`, `explain_incomplete`, `graph_delta`, `architecture_drift`, and `change_gate` use transient or read-only repository analysis. Keep `src/core/change/transient-graph.ts` and its source snapshot behavior unchanged; only share non-mutating types/helpers if that can be done without making Phase 13 write state.

## Planned file structure

### Create

- `src/core/facts/facts.types.ts` — ParsedFactsBlob, fact families, parser identity, FactBlobKey, FileFactBinding, and MaterializedFileFacts contracts.
- `src/core/facts/facts-identity.ts` — canonical FactBlobKey input and content-addressed key calculation.
- `src/core/facts/facts-codec.ts` — deterministic JSON encoding, decoding, schema validation, and cache-miss classification.
- `src/core/facts/facts-extractor.ts` — one source-to-ParsedFacts extraction boundary using the existing parser adapters and structural extractors.
- `src/core/indexing/index-manifest.ts` — generation manifest and per-file fact binding records.
- `src/core/indexing/invalidation-planner.ts` — pure deterministic invalidation input/output types and planner.
- `src/core/indexing/index-work-counters.ts` — internal counters for scanned, hashed, parsed, reused, resolved, importer, and fallback work.

### Modify

- `src/core/graph/parsers/types.ts` and `src/core/graph/parsers/code-parser.ts` — expose parser identity and parsed-root diagnostics without changing supported languages.
- `src/core/graph/parsers/adapters/javascript-extractor.ts` and `src/core/graph/parsers/adapters/typescript.ts` — preserve current symbol/containment extraction while adapting it to facts.
- `src/core/graph/imports.ts`, `src/core/graph/import-bindings.ts`, `src/core/graph/calls.ts`, `src/core/graph/member-resolution.ts`, and `src/core/graph/extends.ts` — accept extracted structural facts where graph indexing currently reparses source.
- `src/core/graph/build-graph.ts` and `src/core/graph/build-file-updates.ts` — consume MaterializedFileFacts and retain existing resolver calls.
- `src/core/graph/graph-index.service.ts` — use the invalidation plan and generation candidate instead of independently deciding direct changes.
- `src/core/indexing/filesystem-change-detector.ts`, `src/core/indexing/index-pipeline.service.ts`, and `src/core/indexing/indexing.types.ts` — carry source snapshots, plans, generation IDs, counters, and lifecycle outcomes.
- `src/core/repository/index-version.ts` and `src/core/repository/repository-status.service.ts` — map four version domains and keep status read-only.
- `src/core/lexical/lexical-index.service.ts` and `src/core/semantic/semantic-index.service.ts` — consume materialized facts/source text without a second Tree-sitter parse.
- `src/core/graph/indexed-graph.service.ts` and `src/adapters/cli/indexing.command.ts` — read only the active generation and route status through the non-mutating service.
- `src/storage/atlas/atlas.schema.ts`, `src/storage/atlas/atlas.types.ts`, and `src/storage/atlas/atlas.store.ts` — add immutable fact-blob storage first, then generation-scoped bindings/graph/derived ownership plus atomic active-generation publication while retaining the existing SQLite engine and legacy read path.

### Test

- Create `test/phase14a-facts.test.ts`, `phase14a-cache.test.ts`, `phase14a-generation.test.ts`, `phase14a-invalidation.test.ts`, `phase14a-single-parse.test.ts`, `phase14a-indexing.test.ts`, `phase14a-races.test.ts`, `phase14a-failures.test.ts`, `phase14a-readonly.test.ts`, `phase14a-equivalence.test.ts`, and `phase14a-final-regression.test.ts`.
- Extend only the existing test files whose current assertions are directly affected: `test/phase4-index-pipeline.test.ts`, `test/graph.test.ts`, `test/phase3-lexical.test.ts`, `test/phase12-cli-regression.test.ts`, `test/phase13-remediation.test.ts`, `test/phase10-mcp.test.ts`, and `test/phase11-integration.test.ts`.

## Implementation tasks

### Task 1: Define ParsedFacts contracts and version domains

**Purpose**

Create the shared type boundary before changing any indexer. Audit every candidate reused type (`CodeChunk`, `ImportReference`, `ImportBinding`, and related parser DTOs) before reuse. Reuse a type only when all persisted fields are syntax-derived and path-neutral; if it carries repository path, repository ID, resolved target, confidence, graph identity, or other materialized state, define a dedicated fact DTO that copies only the structural fields the parser directly proves.

**Files**

- Create: `src/core/facts/facts.types.ts`, `src/core/facts/facts-identity.ts`.
- Modify: `src/core/graph/parsers/types.ts`, `src/core/repository/index-version.ts`, `src/storage/atlas/atlas.types.ts`.
- Test: `test/phase14a-facts.test.ts`.

**Interfaces**

- Consumes: `SupportedLanguage`, `SymbolType`, existing parser adapter metadata, source `contentHash`, and current index version constants.
- Produces:

  ```ts
  export type ParseStatus = "complete" | "deterministic_partial";
  export type FactLocalId = `symbol:${number}` | `scope:${number}` | `import:${number}` | `export:${number}` | `reference:${number}` | `call:${number}` | `binding:${number}` | `type:${number}`;
  export type ParserIdentity = {
    language: SupportedLanguage;
    parserName: string;
    parserVersion: string;
    grammarName: string;
    grammarVersion: string;
    adapterVersion: string;
  };
  export type SourceRangeFact = { startLine: number; endLine: number; startColumn?: number; endColumn?: number };
  export type ParsedSymbolFact = { localId: FactLocalId; name: string; kind: SymbolType; range: SourceRangeFact; scopeId?: FactLocalId; declaredQualifiedName?: string };
  export type ContainmentScopeFact = { localId: FactLocalId; kind: string; name?: string; parentId?: FactLocalId; range: SourceRangeFact };
  export type ImportFact = { localId: FactLocalId; moduleSpecifier: string; importedName?: string; localName?: string; kind: string; range: SourceRangeFact };
  export type ExportFact = { localId: FactLocalId; exportedName?: string; localName?: string; moduleSpecifier?: string; kind: string; range: SourceRangeFact };
  export type ReferenceFact = { localId: FactLocalId; name: string; ownerId?: FactLocalId; scopeId?: FactLocalId; range: SourceRangeFact };
  export type CallSiteFact = { localId: FactLocalId; calleeText: string; callerId?: FactLocalId; scopeId?: FactLocalId; range: SourceRangeFact };
  export type BindingSeedFact = { localId: FactLocalId; name: string; bindingKind: string; sourceModule?: string; importedName?: string; ownerId?: FactLocalId; range: SourceRangeFact };
  export type DeclaredTypeAnnotationFact = { localId: FactLocalId; ownerId: FactLocalId; text: string; range: SourceRangeFact };
  export type ParsedFactsBlob = { factsSchemaVersion: string; factsVersion: string; contentHash: string; language: SupportedLanguage; parserIdentity: ParserIdentity; parseStatus: ParseStatus; parserDiagnostics: string[]; symbols: ParsedSymbolFact[]; containmentScopes: ContainmentScopeFact[]; imports: ImportFact[]; exports: ExportFact[]; references: ReferenceFact[]; callSites: CallSiteFact[]; bindingSeeds: BindingSeedFact[]; declaredTypeAnnotations: DeclaredTypeAnnotationFact[] };
  export type FactBlobKey = string & { readonly __brand: "FactBlobKey" };
  export type FileFactBinding = { repositoryId: string; relativePath: string; generationId: string; factBlobKey: FactBlobKey; contentHash: string; language: SupportedLanguage };
  export type MaterializedFileFacts = { relativePath: string; facts: ParsedFactsBlob };
  export type IndexVersionDomains = { schemaVersion: string; factsVersion: string; resolutionVersion: string; derivedVersion: string };
  export function factBlobKey(input: Pick<ParsedFactsBlob, "contentHash" | "language" | "parserIdentity" | "factsVersion" | "factsSchemaVersion">): FactBlobKey;
  ```

- The identity function must hash canonical JSON of the five key fields in this order: content hash, language, parser identity, facts version, facts schema version. It must not include repository ID or path.

**Behavioral invariants**

- `factsSchemaVersion` changes when serialized shape or validation changes; `factsVersion` changes when extraction semantics change; `parserIdentity` records concrete parser/runtime/grammar provenance and remains independently comparable.
- Parser identity mismatch and facts-version mismatch are fact cache misses; resolution-version changes do not require parsing; derived-version changes do not require parsing or resolver rebuild when the graph is compatible.
- Resolved node IDs, resolved edges, confidence, repository IDs, repository-relative paths, and resolver evidence are not fields in ParsedFactsBlob.
- Before reusing any existing parser/graph DTO, add an assertion or type-level check proving the selected persisted fields are path-neutral structural evidence. Do not persist a whole `CodeChunk`, `ImportReference`, or `ImportBinding` object merely for convenience.

- [ ] Step 1: Add `test/phase14a-facts.test.ts` with assertions for path-independent keys, parser-identity mismatch, facts-version mismatch, resolution-only change, derived-only change, and a path-neutral DTO audit fixture showing no persisted fact field owns repository/path/resolved state.
- [ ] Step 2: Run `node --import tsx/esm --test test/phase14a-facts.test.ts`; confirm it fails because the facts modules and version-domain mapping do not exist.
- [ ] Step 3: Add the contracts and key function above; update existing version types without changing current graph/vector refresh behavior yet.
- [ ] Step 4: Rerun the focused test and confirm all contract/key assertions pass.
- [ ] Step 5: Run `node --import tsx/esm --test test/phase0-*.test.ts test/phase4-index-pipeline.test.ts`; confirm existing version tests remain green.
- [ ] Step 6: Run `npx tsc --noEmit` and inspect the diff for duplicate/conflicting exported type names.
- [ ] Step 7: Commit only these contract changes with `git add src/core/facts src/core/graph/parsers/types.ts src/core/repository/index-version.ts src/storage/atlas/atlas.types.ts test/phase14a-facts.test.ts && git commit -m "feat(index): define parsed fact contracts"`.

### Task 2: Establish the canonical source-to-facts extraction boundary

**Purpose**

Turn the current structural extraction into one call per source snapshot. The extractor must preserve current symbol, import/export, call-site, binding, containment, and parser-diagnostic semantics while emitting only evidence, not resolved graph conclusions.

**Files**

- Create: `src/core/facts/facts-extractor.ts`.
- Modify: `src/core/graph/parsers/types.ts`, `src/core/graph/parsers/code-parser.ts`, `src/core/graph/parsers/adapters/javascript-extractor.ts`, `src/core/graph/parsers/adapters/typescript.ts`, `src/core/graph/imports.ts`, `src/core/graph/import-bindings.ts`, `src/core/graph/calls.ts`, `src/core/graph/member-resolution.ts`, `src/core/graph/extends.ts`.
- Test: `test/phase14a-facts.test.ts`, `test/graph.test.ts`.

**Interfaces**

- Consumes: source text, explicit `language`, `contentHash`, `factsVersion`, `factsSchemaVersion`, and the current `LanguageAdapter` selected before extraction. Repository-relative path is not an extractor input; path enters only at `materializeFileFacts`.
- Produces:

  ```ts
  export type FactExtractionInput = { source: string; language: SupportedLanguage; contentHash: string; factsVersion: string; factsSchemaVersion: string };
  export type FactExtractionOutcome = { kind: "facts"; facts: ParsedFactsBlob } | { kind: "infrastructure_failure"; error: Error };
  export function extractParsedFacts(input: FactExtractionInput): FactExtractionOutcome;
  export function materializeFileFacts(relativePath: string, facts: ParsedFactsBlob): MaterializedFileFacts;
  ```

- `extractParsedFacts` owns one parser/tree per source. It may call pure structural visitors over that tree and existing regex import helpers, but graph builders receive its result instead of calling parser factories again.

**Behavioral invariants**

- A fresh extraction followed by the existing resolver produces the same graph semantics as the current clean build after normalizing only intentionally nondeterministic metadata.
- Fact arrays use path-neutral local IDs and preserve source order; imports and exports preserve source-level module specifiers; diagnostics distinguish a deterministic partial tree from an infrastructure exception.
- The same source text, language, parser identity, facts version, and schema version extracted under two different repository-relative paths MUST produce semantically identical `ParsedFactsBlob` values and the same `FactBlobKey`; only `MaterializedFileFacts`/resolution may differ by path.
- No type propagation, framework registry, semantic body/signature dependency, or resolver-v2 inference is added.

- [ ] Step 1: Add a test fixture with a TypeScript file containing a class, method, function call, import/export, local binding, nested scope, and declared type; assert exact fact family counts/local-ID shapes, then materialize the same extracted blob at two different paths and assert the blob/key stay identical while only the materialized path differs.
- [ ] Step 2: Run `node --import tsx/esm --test test/phase14a-facts.test.ts test/graph.test.ts`; confirm the new extraction test fails before the canonical extractor exists.
- [ ] Step 3: Implement `extractParsedFacts` by adapting the current parser adapter visitor and feeding existing structural extractors from the one parsed tree; add the adapter/parser identity returned by `code-parser.ts`.
- [ ] Step 4: Add a test adapter that converts `ParsedFactsBlob` into the existing graph builder input and compare nodes/edges with the current clean fixture graph.
- [ ] Step 5: Run `node --import tsx/esm --test test/phase14a-facts.test.ts test/graph.test.ts test/phase7-resolution-evidence.test.ts`; confirm the equivalence assertions pass.
- [ ] Step 6: Run `npx tsc --noEmit`; inspect that no fact field contains repository path ownership or resolved graph output.
- [ ] Step 7: Commit with `git add src/core/facts/facts-extractor.ts src/core/graph/parsers src/core/graph/imports.ts src/core/graph/import-bindings.ts src/core/graph/calls.ts src/core/graph/member-resolution.ts src/core/graph/extends.ts test/phase14a-facts.test.ts test/graph.test.ts && git commit -m "refactor(index): extract canonical parsed facts"`.

### Task 3: Persist and validate immutable fact blobs

**Purpose**

Add immutable content-addressed fact-blob storage to the existing Atlas SQLite database. Task 3 deliberately does NOT create generation-scoped path bindings or GC; those depend on the active/candidate generation model and are owned by Task 4. Corrupt or incompatible blob data is treated as a miss and repaired only through the normal mutating index lifecycle.

**Files**

- Create: `src/core/facts/facts-codec.ts`.
- Modify: `src/storage/atlas/atlas.schema.ts`, `src/storage/atlas/atlas.types.ts`, `src/storage/atlas/atlas.store.ts`.
- Test: `test/phase14a-cache.test.ts`.

**Interfaces**

- Consumes: `ParsedFactsBlob`, `FactBlobKey`, existing `AtlasStore` database path and transaction helpers.
- Produces:

  ```ts
  export type FactCacheLookup = { kind: "hit"; facts: ParsedFactsBlob } | { kind: "miss"; reason: "absent" | "invalid_json" | "schema_mismatch" | "hash_mismatch" | "version_mismatch" | "parser_identity_mismatch" };
  export function encodeFacts(facts: ParsedFactsBlob): string;
  export type FactCacheExpectation = { key: FactBlobKey; contentHash: string; language: SupportedLanguage; parserIdentity: ParserIdentity; factsVersion: string; factsSchemaVersion: string };
  export function decodeFacts(payload: string, expected: FactCacheExpectation): FactCacheLookup;
  ```

- Add store methods `getFactBlob(key: FactBlobKey): string | undefined` and `putFactBlob(key: FactBlobKey, facts: ParsedFactsBlob): void`; the store calls `decodeFacts` after loading raw JSON and the facts core remains independent of SQLite. A valid content-addressed row is immutable; replacing a corrupted row with freshly validated payload is an explicit repair path in a mutating lifecycle.

**Behavioral invariants**

- `fact_blobs` is immutable/content-addressed and stores compact deterministic JSON plus key/version/hash metadata; it stores no full source, AST, embeddings, repository path, or generation-owned binding.
- Same content plus compatible parser/facts provenance produces the same `FactBlobKey` regardless of repository/path. Binding-based rename/revert reuse is exercised after Task 4 introduces `file_fact_bindings`.
- Invalid JSON, schema mismatch, facts-version mismatch, parser-identity mismatch, or hash/key mismatch yields MISS, then reparse and safe repair in the mutating lifecycle.
- Task 3 adds no GC API. Global reference-safe GC is introduced only after Task 4 has generation-scoped bindings and active-generation semantics.

- [ ] Step 1: Add cache tests for put/get, deterministic round-trip, each miss reason, cross-path/cross-repository identical-key reuse, and corrupt-row repair; corrupt payloads via a test-only direct SQLite fixture update, not a production API.
- [ ] Step 2: Run `node --import tsx/esm --test test/phase14a-cache.test.ts`; confirm failures identify missing tables/store methods/codec behavior.
- [ ] Step 3: Add schema v2 tables and indexes using the existing `initializeAtlasSchema`/migration convention; implement codec validation and the narrow store methods inside existing SQLite transactions.
- [ ] Step 4: Rerun `node --import tsx/esm --test test/phase14a-cache.test.ts`; confirm all hit/miss/repair assertions pass.
- [ ] Step 5: Run `node --import tsx/esm --test test/phase0-*.test.ts test/phase3-lexical.test.ts`; confirm current database and lexical persistence behavior remains green.
- [ ] Step 6: Run `npx tsc --noEmit` and `git diff --check`; verify no new storage engine or serialized binary format was introduced.
- [ ] Step 7: Commit with `git add src/core/facts/facts-codec.ts src/storage/atlas/atlas.schema.ts src/storage/atlas/atlas.types.ts src/storage/atlas/atlas.store.ts test/phase14a-cache.test.ts && git commit -m "feat(index): persist content-addressed parsed facts"`.

### Task 4: Add active/candidate generation state and manifests

**Purpose**

Give every mutating index run an isolated generation and make `active_generation_id` the only reader entry point. Candidate bindings, manifest, graph, and derived outputs become visible together only at publication.

**Files**

- Create: `src/core/indexing/index-manifest.ts`.
- Modify: `src/storage/atlas/atlas.schema.ts`, `src/storage/atlas/atlas.types.ts`, `src/storage/atlas/atlas.store.ts`, `src/core/graph/indexed-graph.service.ts`.
- Test: `test/phase14a-generation.test.ts`.

**Interfaces**

- Consumes: `FileFactBinding`, current repository identity, current `IndexVersionDomains`, graph/lexical candidate payloads, and semantic candidate payloads only when the semantic capability is enabled for the run.
- Produces:

  ```ts
  export type IndexGeneration = { id: string; repositoryId: string; parentGenerationId?: string; versions: IndexVersionDomains; status: "candidate" | "committed"; manifest: IndexManifest };
  export type IndexManifest = { generationId: string; files: FileFactBinding[]; createdAt: string };
  export function createCandidateGeneration(repositoryId: string, parentGenerationId: string | undefined, versions: IndexVersionDomains, files: FileFactBinding[]): IndexGeneration;
  ```

- Add store methods `getActiveGenerationId(repositoryId: string): string | undefined`, `beginCandidateGeneration(...)`, `writeCandidateManifest(...)`, generation-scoped binding/graph/derived writers, `publishCandidateGeneration(...)`, and generation-aware readers.
- Lock the v2 persistence model to generation-owned rows: `file_fact_bindings`, graph nodes/edges, lexical documents, and semantic rows (when semantic is enabled) carry `repository_id + generation_id` ownership. Existing keys/indexes must be extended or v2 shadow tables introduced so N+1 rows never overwrite N rows in place. Normal v2 readers first resolve `repository_index_state.active_generation_id` and then read only rows for that generation.
- Legacy rows remain readable through an explicit dual read path: if the database has no v2 repository generation state, read the existing legacy graph/status rows without creating tables, migrating, or synthesizing an active generation. Task 10 later owns the mutating upgrade.
- `publishCandidateGeneration` validates only capabilities that are enabled/required by the current run, then atomically switches `repository_index_state.active_generation_id` (plus the minimum consistent metadata) from N to N+1. A disabled or currently unavailable optional semantic capability must preserve its existing capability semantics and must not become a new mandatory publication dependency.
- Add global reference-safe GC after successful publication: `deleteUnreferencedFactBlobs(): number` may delete a blob only when no `file_fact_bindings` row in any repository/generation still references its key. Candidate cleanup may remove abandoned bindings first; GC must never use a repository-local reference check for a globally content-addressed blob.

**Behavioral invariants**

- `repository_index_state` owns the active pointer and version/provenance metadata; candidate state is never written into active rows in place.
- For v2 state, readers select only the active generation. For legacy state, readers use the pre-v2 read path without mutation until an explicit mutating lifecycle upgrades it. No historical browsing, rollback, or public generation selection is added.
- If candidate validation, graph writes, derived writes, cache writes, or process interruption fails before publication, the prior generation remains active and the candidate is not readable.
- Graph, lexical, and enabled-semantic candidate rows remain physically/logically isolated by `generation_id`; no capability-specific writer may overwrite the currently active generation before publication.
- Global fact GC is reference-safe across repositories and generations. There is no LRU, TTL, background daemon, or public cache browser.
- Existing SQLite `BEGIN IMMEDIATE`/commit/rollback helpers are reused; publication is one atomic database operation, not a sequence of capability-specific visible commits.

- [ ] Step 1: Test cold candidate creation, generation-scoped graph/lexical visibility, optional-semantic disabled behavior, active-reader selection, atomic pointer switch, failed candidate retention of N, no candidate visibility through `loadIndexedGraphReadOnly`, legacy read fallback without schema mutation, same-content rename/revert binding reuse, and cross-repository GC safety for a shared FactBlobKey.
- [ ] Step 2: Run `node --import tsx/esm --test test/phase14a-generation.test.ts`; confirm missing generation tables and pointer APIs fail.
- [ ] Step 3: Add `repository_index_state`, generation metadata/manifest storage, generation-scoped `file_fact_bindings`, and generation ownership for graph/lexical/enabled-semantic rows; add dual legacy/v2 read selection, global reference-safe fact GC, candidate completeness validation, and one transaction that switches `active_generation_id`.
- [ ] Step 4: Rerun the generation test and confirm readers see N before publication and N+1 only after publication.
- [ ] Step 5: Run `node --import tsx/esm --test test/phase4-index-pipeline.test.ts test/phase13-remediation.test.ts`; confirm existing graph loading and read-only tests remain green.
- [ ] Step 6: Run `npx tsc --noEmit` and inspect all SQL paths to confirm active and candidate bindings cannot overlap through an active-row update.
- [ ] Step 7: Commit with `git add src/core/indexing/index-manifest.ts src/storage/atlas/atlas.schema.ts src/storage/atlas/atlas.types.ts src/storage/atlas/atlas.store.ts src/core/graph/indexed-graph.service.ts test/phase14a-generation.test.ts && git commit -m "feat(index): add generation manifests"`.

### Task 5: Implement pure invalidation and the reverse importer index

**Purpose**

Move invalidation decisions from ad hoc graph state into a deterministic planner driven by content/hash changes, compatible facts, imports, and version domains. Direct importers are file/module relationships only; uncertainty broadens resolution, never fact parsing.

**Files**

- Create: `src/core/indexing/invalidation-planner.ts`.
- Modify: `src/core/indexing/filesystem-change-detector.ts`, `src/core/graph/graph-index.service.ts`, `src/storage/atlas/atlas.store.ts`.
- Test: `test/phase14a-invalidation.test.ts`.

**Interfaces**

- Consumes:

  ```ts
  export type InvalidationInput = { repositoryFiles: string[]; currentFiles: Map<string, { contentHash: string; language: SupportedLanguage }>; previousBindings: Map<string, FileFactBinding>; directImporters: Map<string, Set<string>>; versions: IndexVersionDomains; previousVersions?: IndexVersionDomains; };
  ```

- Produces:

  ```ts
  export type DependencyImpact = "bounded" | "uncertain";
  export type InvalidationPlan = { parsePaths: string[]; reusePaths: string[]; resolvePaths: string[]; removedPaths: string[]; derivedRebuild: boolean; fullGraphResolution: boolean; dependencyImpact: DependencyImpact; importersInvalidated: string[]; reasons: string[] };
  export function planInvalidation(input: InvalidationInput): InvalidationPlan;
  export function buildReverseImporterIndex(imports: Map<string, ImportReference[]>): Map<string, Set<string>>;
  ```

**Behavioral invariants**

- Unchanged compatible bindings are reused; modified/added files with no compatible blob are parsed; deleted paths are removed from the candidate graph and manifest.
- Modified files and direct importers are resolved. An unresolved/global module candidate or incomplete importer relation sets `dependencyImpact` to `uncertain`, selects repository-wide resolution, and leaves compatible facts reusable.
- Resolution-version changes select resolution work with `parsePaths=[]`; facts-version changes select all relevant parsing; derived-version changes select only derived rebuild when graph compatibility holds.
- Rename with identical content reuses the content-addressed blob and does not parse; moving across a module boundary can broaden resolution without broadening parsing.
- No symbol-level, type-consumer, body/signature, or semantic dependency invalidation is introduced.

- [ ] Step 1: Add table-driven planner tests for unchanged, leaf modify, dependency modify, delete, add, same-content rename, module-boundary move, resolution bump, facts bump, derived bump, and uncertain fallback.
- [ ] Step 2: Run `node --import tsx/esm --test test/phase14a-invalidation.test.ts`; confirm planner and reverse-index exports are absent/failing.
- [ ] Step 3: Implement sorted-set planner logic and reverse importer construction from existing import facts; make all output arrays deterministic.
- [ ] Step 4: Rerun the planner test and assert uncertain impact has broad resolution with zero extra parse paths.
- [ ] Step 5: Run `node --import tsx/esm --test test/phase4-index-pipeline.test.ts test/graph.test.ts`; confirm existing direct-importer behavior remains correct.
- [ ] Step 6: Run `npx tsc --noEmit`; inspect that planner output cannot request semantic invalidation or a parser run for a resolution-only bump.
- [ ] Step 7: Commit with `git add src/core/indexing/invalidation-planner.ts src/core/indexing/filesystem-change-detector.ts src/core/graph/graph-index.service.ts src/storage/atlas/atlas.store.ts test/phase14a-invalidation.test.ts && git commit -m "feat(index): plan dependency invalidation"`.

### Task 6: Integrate single-parse facts with graph, lexical, and semantic indexing

**Purpose**

Make a fact cache miss the only reason the mutating index path invokes Tree-sitter. Graph construction consumes `MaterializedFileFacts`; lexical indexing consumes the same facts plus source text; semantic indexing consumes the same facts plus its existing embedding-text path.

**Files**

- Create: none.
- Modify: `src/core/graph/build-graph.ts`, `src/core/graph/build-file-updates.ts`, `src/core/graph/graph-index.service.ts`, `src/core/lexical/lexical-index.service.ts`, `src/core/semantic/semantic-index.service.ts`, `src/core/indexing/indexing.types.ts`.
- Test: `test/phase14a-single-parse.test.ts`, `test/phase14a-equivalence.test.ts`.

**Interfaces**

- Consumes: `MaterializedFileFacts`, source text, `InvalidationPlan`, and the existing `CodeGraph`/resolution APIs.
- Produces: `IndexedSourceUnit = { relativePath: string; source: string; facts: ParsedFactsBlob }`; `buildCodeGraphWithResolutionFromFacts(repoPath: string, units: IndexedSourceUnit[], reporter?: ProgressReporter, repositoryId?: string): Promise<GraphBuildResult>`; `buildFileGraphsFromFacts(repoPath: string, repoId: string, units: IndexedSourceUnit[], allRepoFiles: Set<string>, baseGraph: CodeGraph, reporter?: ProgressReporter): Promise<BuiltFileGraph[]>`; and `toLexicalDocumentsFromFacts(repositoryId: string, unit: IndexedSourceUnit): LexicalDocument[]`.

**Behavioral invariants**

- Mutating indexing invokes Tree-sitter exactly once per fact cache miss, not once per capability.
- Existing graph nodes, imports, calls, extends relations, evidence, and unique-or-drop resolution remain equivalent on clean fixtures.
- Lexical and semantic consumers may use source text but do not parse it again. `src/core/change/transient-graph.ts` keeps its independent Phase 13 path.

- [ ] Step 1: Add a parser-factory counter and cold/unchanged/one-file-modified assertions whose expected count equals fact misses.
- [ ] Step 2: Run `node --import tsx/esm --test test/phase14a-single-parse.test.ts`; confirm independent capability parses make the counter fail.
- [ ] Step 3: Thread `IndexedSourceUnit` through graph builders and replace lexical/semantic parser calls with facts-to-document/chunk conversion.
- [ ] Step 4: Rerun the focused test and clean graph equivalence fixture; confirm one parse per miss.
- [ ] Step 5: Run `node --import tsx/esm --test test/graph.test.ts test/phase3-lexical.test.ts test/phase14a-equivalence.test.ts`.
- [ ] Step 6: Run `npx tsc --noEmit` and inspect that Phase 13 transient parsing is unchanged.
- [ ] Step 7: Commit `perf(index): reuse parsed facts across indexing` with only the listed paths.

### Task 7: Integrate fact reuse into init, index, and sync

**Purpose**

Replace separate capability publication with one repository lifecycle: capture/hash, plan, cache lookup, parse misses, resolve, build derived state, validate, and publish one candidate while preserving CLI/MCP surfaces.

**Files**

- Create: none.
- Modify: `src/core/indexing/index-pipeline.service.ts`, `src/core/indexing/filesystem-change-detector.ts`, `src/core/indexing/indexing.types.ts`, `src/core/graph/graph-index.service.ts`, `src/core/lexical/lexical-index.service.ts`, `src/core/semantic/semantic-index.service.ts`, `src/core/repository/index-version.ts`, `src/storage/atlas/atlas.store.ts`.
- Test: `test/phase14a-indexing.test.ts`, `test/phase4-index-pipeline.test.ts`, `test/phase11-integration.test.ts`.

**Interfaces**

- Consumes: `IndexPipelineOptions`, current source files/hashes, `IndexVersionDomains`, and `planInvalidation`.
- Produces:

  ```ts
  export type PublishedIndexRun = { kind: "published"; repositoryId: string; generationId: string; plan: InvalidationPlan; published: true };
  export type FailedIndexRun = { kind: "failed"; repositoryId: string; activeGenerationId?: string; published: false; failure: IndexFailure };
  export type IndexRunOutcome = PublishedIndexRun | FailedIndexRun;
  export async function indexRepository(repoPath: string, options?: IndexPipelineOptions): Promise<IndexRunOutcome>;
  export async function syncRepository(repoPath: string, options?: IndexPipelineOptions): Promise<IndexRunOutcome>;
  ```

- CLI/MCP wrappers map `kind="failed"` into the existing exit/error/wire behavior. Do not mix typed throws for expected index lifecycle failures with result unions; unexpected programmer errors may still throw.

**Behavioral invariants**

- `init`, `index`, and `sync` retain existing arguments, exit behavior, progress reporter, colors, icons, TTY handling, and `NO_COLOR` behavior.
- Deleted paths remove stale graph nodes/edges and bindings. Repeated indexing with no source changes performs no fact parsing.
- No capability-specific transaction publishes before candidate validation. Candidate validation requires graph/lexical and only those optional capabilities enabled/required by the current run; semantic disabled/unavailable behavior remains compatible with the existing capability model and never becomes a new mandatory runtime dependency.

- [ ] Step 1: Add cold, unchanged, leaf-change, dependency-change, deletion, repeated-sync, and CLI/MCP completion tests.
- [ ] Step 2: Run `node --import tsx/esm --test test/phase14a-indexing.test.ts test/phase4-index-pipeline.test.ts`; confirm the old lifecycle lacks one generation/result.
- [ ] Step 3: Orchestrate the pipeline-owned `IndexRunOutcome` and stage all candidate outputs through generation store APIs.
- [ ] Step 4: Rerun focused integration tests and assert one active-pointer change per successful run.
- [ ] Step 5: Run `node --import tsx/esm --test test/phase4-index-pipeline.test.ts test/phase10-mcp.test.ts test/phase11-integration.test.ts`.
- [ ] Step 6: Run `npx tsc --noEmit` and inspect capability publication boundaries.
- [ ] Step 7: Commit `feat(index): integrate incremental fact reuse` with only the listed paths.

### Task 8: Add race-safe source capture and atomic publication guards

**Purpose**

Prevent a mutable working tree from producing mixed-generation state by comparing source hashes before and after extraction, retrying one race, and aborting after the second.

**Files**

- Create: none.
- Modify: `src/core/indexing/filesystem-change-detector.ts`, `src/core/indexing/index-pipeline.service.ts`, `src/storage/atlas/atlas.store.ts`.
- Test: `test/phase14a-races.test.ts`, `test/phase14a-generation.test.ts`.

**Interfaces**

- Consumes: existing source reader/hash logic and `extractParsedFacts` through injected seams.
- Produces:

  ```ts
  export type SourceRead = { source: string; contentHash: string };
  export type SourceReader = (relativePath: string) => Promise<SourceRead>;
  export type StableFactExtraction = { source: string; facts: ParsedFactsBlob };
  export async function extractStableFacts(relativePath: string, reader: SourceReader, extractor: (read: SourceRead) => FactExtractionOutcome, maxAttempts?: number): Promise<StableFactExtraction>;
  ```

- Each attempt MUST execute in this order: `before = reader(path)` -> `extractor(before)` -> `after = reader(path)` -> compare `before.contentHash` with `after.contentHash`. The second capture therefore occurs after Tree-sitter extraction, closing the source-read/parse TOCTOU window.

**Behavioral invariants**

- A first post-extraction hash mismatch discards both source/facts and retries once. A second mismatch aborts N+1 and retains N as active.
- Candidate bindings, manifest, graph, and derived outputs stay isolated until the atomic pointer transaction.
- Fault injection uses deterministic reader sequences and transaction errors, never timing or polling.

- [ ] Step 1: Add deterministic before/extract/after sequences proving the second hash read happens after extraction; cover one mismatch followed by a stable retry and two mismatches, and assert extraction count, retry count, active ID, and typed failure. Include a regression where the file is stable for two pre-parse reads but changes during extraction; the test must fail unless the post-extraction read catches it.
- [ ] Step 2: Run `node --import tsx/esm --test test/phase14a-races.test.ts`; confirm the post-extraction stability seam is absent.
- [ ] Step 3: Implement `extractStableFacts` and route mutating fact extraction through it; refuse publication on a source-race or infrastructure-failure outcome.
- [ ] Step 4: Rerun race/generation tests and assert ordinary runs still publish.
- [ ] Step 5: Run `node --import tsx/esm --test test/phase14a-indexing.test.ts test/phase14a-generation.test.ts`.
- [ ] Step 6: Run `npx tsc --noEmit` and inspect rollback paths around pointer writes.
- [ ] Step 7: Commit `fix(index): guard source generation publication` with only the listed paths.

### Task 9: Encode malformed-source, infrastructure-failure, and cache-write semantics

**Purpose**

Separate deterministic partial parsing from infrastructure failure. Partial facts may publish with diagnostics; parser/extractor exceptions, corrupt cache, and cache-write errors cannot publish authoritative N+1 state.

**Files**

- Create: none.
- Modify: `src/core/facts/facts-extractor.ts`, `src/core/facts/facts-codec.ts`, `src/core/indexing/index-pipeline.service.ts`, `src/storage/atlas/atlas.store.ts`, `src/core/graph/build-graph.ts`.
- Test: `test/phase14a-failures.test.ts`, `test/phase14a-cache.test.ts`.

**Interfaces**

- Consumes: `FactExtractionOutcome`, parser diagnostics, `FactCacheLookup`, and candidate transaction errors.
- Produces: `IndexFailure = { kind: "source_race" | "infrastructure_failure" | "cache_write_failure"; message: string; activeGenerationId?: string }`; refine `extractParsedFacts` so parser/adapter exceptions return `infrastructure_failure` while deterministic parser diagnostics remain in `ParsedFactsBlob`. The pipeline returns `IndexRunOutcome` with `kind="failed"` for these expected lifecycle failures; CLI/MCP wrappers preserve existing external failure semantics.

**Behavioral invariants**

- Malformed source with a deterministic partial tree stores `parseStatus="deterministic_partial"`, diagnostics, incomplete downstream state, and reusable unchanged facts.
- Infrastructure failure publishes no authoritative blob and leaves N active. Corrupt cache is a miss and cache-write failure aborts publication.

- [ ] Step 1: Add tests for partial publication/reuse, injected parser exception, invalid-cache repair, and cache-write failure with active-generation assertions.
- [ ] Step 2: Run `node --import tsx/esm --test test/phase14a-failures.test.ts`; confirm failure classes are not distinct.
- [ ] Step 3: Implement discriminated outcomes, diagnostics persistence, rollback, and cache-write atomicity.
- [ ] Step 4: Rerun failure tests and assert which paths may publish.
- [ ] Step 5: Run `node --import tsx/esm --test test/phase14a-cache.test.ts test/phase14a-indexing.test.ts test/graph.test.ts`.
- [ ] Step 6: Run `npx tsc --noEmit` and inspect that exceptions cannot become empty authoritative facts.
- [ ] Step 7: Commit `fix(index): harden parsed fact failure semantics` with only the listed paths.

### Task 10: Migrate legacy indexes only through mutating lifecycles and preserve read-only behavior

**Purpose**

Make old databases safe to read and explicit to upgrade. Read-only access must first detect legacy versus v2 storage without initializing schema: v2 reads through `active_generation_id`, while legacy reads the existing pre-v2 graph/status rows directly. The first mutating `init`, `index`, or `sync` performs one full source extraction into facts, resolves a v2 candidate, and publishes it.

**Files**

- Modify: `src/core/repository/repository-status.service.ts`, `src/core/graph/indexed-graph.service.ts`, `src/adapters/cli/indexing.command.ts`, `src/core/indexing/index-pipeline.service.ts`, `src/storage/atlas/atlas.store.ts`.
- Test: `test/phase14a-readonly.test.ts`, `test/phase12-cli-regression.test.ts`, `test/phase13-remediation.test.ts`, `test/phase10-mcp.test.ts`.

**Interfaces**

- Consumes: existing `getRepositoryStatusReadOnly`, `loadIndexedGraphReadOnly`, Phase 13 source snapshot/readers, CLI command dispatch, and legacy schema detection.
- Produces:

  ```ts
  export async function migrateLegacyIndexOnMutation(repositoryPath: string, options: IndexPipelineOptions): Promise<IndexRunOutcome>;
  export async function getRepositoryStatusReadOnly(inputPath: string, providers?: RepositoryStatusProviders): Promise<RepositoryStatus>;
  ```

- The status CLI branch must call `getRepositoryStatusReadOnly`; read-only services open `AtlasStore` with `{ readOnly: true }`, probe v2 state without schema creation, select `active_generation_id` only for v2 repositories, and fall back to the existing legacy read path when v2 generation state is absent.

**Behavioral invariants**

- `status`, `inspect_change`, `affected_tests`, `explain_incomplete`, `graph_delta`, `architecture_drift`, and `change_gate` do not migrate, populate cache, update timestamps, repair bindings, index/sync, or publish a generation.
- Read-only assertions include SQLite DB, WAL/SHM, Git status/config, and repository metadata timestamp stability.
- Legacy upgrade never reconstructs facts from graph rows. It performs full source extraction once, then facts -> existing resolver -> candidate -> publication under `init`, `index`, or `sync` only. Until that mutation succeeds, legacy read-only commands continue using the legacy rows and do not require `repository_index_state` to exist.
- Existing MCP route names, CLI output shape, progress reporter behavior, icons/colors, TTY/non-TTY behavior, and `NO_COLOR` behavior remain compatible.

- [ ] Step 1: Add tests that snapshot DB/WAL/SHM mtimes, Git status/config, repository timestamp, and active generation before each read-only command; add a legacy database fixture and assert it changes only under mutating index.
- [ ] Step 2: Run `node --import tsx/esm --test test/phase14a-readonly.test.ts test/phase13-remediation.test.ts test/phase12-cli-regression.test.ts`; confirm status currently mutates via `getRepositoryStatus` and legacy generation is absent.
- [ ] Step 3: Route all listed read-only commands through existing read-only access, gate legacy upgrade inside the mutating pipeline, and leave `src/core/change/transient-graph.ts` source parsing untouched.
- [ ] Step 4: Rerun the focused tests and assert every read-only snapshot is byte/timestamp-identical while mutating migration publishes one generation.
- [ ] Step 5: Run `node --import tsx/esm --test test/phase10-mcp.test.ts test/phase11-integration.test.ts test/phase13-remediation.test.ts`; confirm fresh MCP and Phase 13 regressions remain green.
- [ ] Step 6: Run `npx tsc --noEmit` and inspect CLI/status call sites for any mutating store construction on read-only paths.
- [ ] Step 7: Commit with `git add src/core/repository/repository-status.service.ts src/core/graph/indexed-graph.service.ts src/adapters/cli/indexing.command.ts src/core/indexing/index-pipeline.service.ts src/storage/atlas/atlas.store.ts test/phase14a-readonly.test.ts test/phase12-cli-regression.test.ts test/phase13-remediation.test.ts test/phase10-mcp.test.ts && git commit -m "feat(index): migrate legacy indexes on mutation"`.

### Task 11: Add deterministic work counters and incremental/full equivalence oracles

**Purpose**

Expose internal test-facing counters and make the correctness oracle executable across multiple fixture families. The oracle compares incremental output with a clean full rebuild after removing only documented nondeterministic metadata.

**Files**

- Create: `src/core/indexing/index-work-counters.ts`.
- Modify: `src/core/indexing/indexing.types.ts`, `src/core/indexing/index-pipeline.service.ts`, `src/core/graph/graph-index.service.ts`, `src/core/lexical/lexical-index.service.ts`, `src/core/semantic/semantic-index.service.ts`.
- Test: `test/phase14a-equivalence.test.ts`, `test/phase14a-indexing.test.ts`, `test/phase14a-single-parse.test.ts`.

**Interfaces**

- Consumes: planner results and lifecycle events.
- Produces:

  ```ts
  export type IndexWorkCounters = { filesScanned: number; filesHashed: number; factCacheHits: number; factCacheMisses: number; filesParsed: number; filesResolved: number; importersInvalidated: number; fullResolutionFallbacks: number };
  export function createIndexWorkCounters(): IndexWorkCounters;
  export function recordIndexWork(counters: IndexWorkCounters, event: keyof IndexWorkCounters, count?: number): void;
  export function freezeIndexWorkCounters(counters: IndexWorkCounters): Readonly<IndexWorkCounters>;
  ```

- `IndexPipelineResult`/`PublishedIndexRun` carries counters internally for tests and progress diagnostics; no new public command or stable external telemetry contract is added.

**Behavioral invariants**

- Cold 100-file fixture: `filesParsed=100`. Unchanged second run: `filesParsed=0`. One modified file: `filesParsed=1`. Same-content rename: `filesParsed=0`.
- Resolution-version bump: `filesParsed=0`. Facts-version bump: every relevant file is parsed. Derived-version bump: `filesParsed=0` and `filesResolved=0` when graph compatibility holds.
- `filesParsed` equals fact cache misses. `filesScanned`, `filesHashed`, importer counts, and fallback counts are deterministic for identical inputs.
- For multiple fixtures covering imports, calls, extends, lexical chunks, malformed files, deletes, and renames, incremental graph equals clean full-rebuild graph after normalization.

- [ ] Step 1: Add a 100-file generated-in-test fixture and assertions for every acceptance counter, plus two smaller fixture families for imports/calls/extends and malformed/deleted/renamed files.
- [ ] Step 2: Run `node --import tsx/esm --test test/phase14a-equivalence.test.ts test/phase14a-indexing.test.ts`; confirm counters and normalized graph oracles fail before instrumentation and clean rebuild comparison exist.
- [ ] Step 3: Add counter events at scan/hash/cache/parse/resolve/importer/fallback boundaries; implement a normalizer that sorts nodes/edges and removes only timestamps, generation IDs, and other explicitly nondeterministic metadata.
- [ ] Step 4: Rerun the focused tests and confirm all acceptance counts plus incremental/full equality pass.
- [ ] Step 5: Run `node --import tsx/esm --test test/phase14a-single-parse.test.ts test/phase4-index-pipeline.test.ts test/phase3-lexical.test.ts`; confirm the counters agree across capabilities.
- [ ] Step 6: Run `npx tsc --noEmit` and inspect that counters cannot alter invalidation or publication decisions.
- [ ] Step 7: Commit with `git add src/core/indexing/index-work-counters.ts src/core/indexing/indexing.types.ts src/core/indexing/index-pipeline.service.ts src/core/graph/graph-index.service.ts src/core/lexical/lexical-index.service.ts src/core/semantic/semantic-index.service.ts test/phase14a-equivalence.test.ts test/phase14a-indexing.test.ts test/phase14a-single-parse.test.ts && git commit -m "test(index): verify incremental graph equivalence"`.

### Task 12: Run final Phase 14A, repository, packaging, and MCP verification

**Purpose**

Close the implementation with fresh evidence across targeted behavior, existing regression coverage, type/lint/build checks, package installation, MCP process isolation, and read-only guarantees. Do not declare implementation complete until every listed gate is run after the final code change.

**Files**

- Modify: none expected. If a verification failure identifies a real Phase 14A defect, fix it in the owning task and rerun that task's focused gate before returning here.
- Test: `test/phase14a-final-regression.test.ts`, plus all existing tests named below.

**Interfaces**

- Consumes: the complete Phase 14A implementation, the current package scripts, `dist/cli.js`, MCP entry point, packed artifact, and fresh temporary install directories.
- Produces: a verification record containing command, exit status, relevant counts, package artifact name/version, MCP response, and read-only mutation snapshots.

**Behavioral invariants**

- Targeted Phase 14A tests and the full suite pass; TypeScript typecheck, `eslint .`, production build, and UI typecheck pass using repository scripts.
- `npm pack --dry-run` passes; a packed npm install smoke and packed pnpm install smoke invoke the compiled CLI successfully from fresh temporary directories.
- Fresh-process MCP smoke passes with the normal environment and with minimal PATH/unset NODE_PATH when those are part of the current repository contract.
- `git diff --check` passes. Phase 13 read-only commands leave database/WAL/SHM, Git status/config, and repository metadata timestamps unchanged.
- No source, test, or `package.json` file outside the intended implementation changes is included; no push or merge occurs.

- [ ] Step 1: Add `test/phase14a-final-regression.test.ts` with a matrix that runs every Phase 14A scenario through the public index/sync lifecycle and checks active-pointer, counters, failure, and read-only invariants.
- [ ] Step 2: Run `node --import tsx/esm --test test/phase14a-*.test.ts`; confirm the complete targeted suite passes and record the exact test count.
- [ ] Step 3: Run `npm test`, `npm run lint`, `npm run build`, and `npm run ui:typecheck`; record each exit status and output summary.
- [ ] Step 4: Run `npm pack --dry-run`, install the produced tarball with npm in a fresh temporary directory, install it with pnpm in another fresh temporary directory, and invoke the compiled CLI from both installs.
- [ ] Step 5: Run fresh-process MCP smoke tests using the repository's existing launcher, once with normal environment and once with minimal PATH and unset NODE_PATH; run Phase 13 mutation snapshots against SQLite/WAL/SHM/Git/timestamps.
- [ ] Step 6: Run `git diff --check`, inspect `git diff`, `git diff --cached`, `git status --short`, and verify the final implementation diff contains no out-of-scope resolver, semantic invalidation, service, or public CLI changes.
- [ ] Step 7: Commit any final test-only adjustment with a focused message, then rerun all failed gates; do not amend unrelated commits and do not push.

## Reviewer clarifications incorporated before execution

- Source-race safety is post-extraction: every mutable-source attempt reads/hash-captures before extraction, extracts facts, then reads/hashes again before accepting the facts. Two pre-parse reads are insufficient.
- V2 candidate isolation is generation-scoped for bindings, graph rows, lexical rows, and enabled semantic rows. `active_generation_id` is the only visibility switch for v2 readers.
- Read-only storage has an explicit dual path: v2 repositories read the active generation; legacy repositories read legacy rows without schema initialization or migration.
- `fact_blobs` are global content-addressed blobs. GC is global-reference-safe across every repository/generation binding, never repository-local.
- Plan execution authorization covers the focused local commits listed in the tasks; push/merge/branch changes remain separately gated.
- Existing DTOs are reused only after proving their persisted fields are path-neutral syntax evidence; otherwise dedicated fact DTOs are required.
- Expected indexing failures use one internal `IndexRunOutcome` union rather than a mixture of expected typed throws and success-only results.
- Existing semantic indexing remains optional; Phase 14A does not make embeddings or a semantic provider mandatory for successful graph/lexical publication.
- `file_fact_bindings` and fact-blob GC are Task 4 responsibilities because their correctness depends on generation state; Task 3 owns blob codec/storage only.
- Path-neutrality is tested end-to-end: same source + language + provenance at two repository paths produces the same facts/blob key, while materialization/resolution may differ.

## Spec coverage checklist

The approved design sections map to these tasks:

| Design requirement | Task(s) |
| --- | --- |
| ParsedFacts/ResolvedGraph boundary and structural fact families | 1, 2, 6 |
| `factsSchemaVersion`, `factsVersion`, parser identity, and FactBlobKey | 1, 3 |
| Path-neutral blobs and FileFactBinding ownership | 1, 3, 4 |
| Four version domains and rebuild matrix | 1, 5, 11 |
| SQLite fact-blob storage, validation, corruption, and repair | 3, 9 |
| Generation-scoped bindings, global reference-safe GC, active pointer, candidate generation, manifest, and atomic publication | 4, 7, 8, 9 |
| Current source capture, hash, and parser duplication removal | 2, 6, 7, 8 |
| Pure invalidation and reverse direct-importer relation | 5, 7 |
| Uncertain dependency impact broadens resolution only | 5, 11 |
| Single parse per fact cache miss | 2, 6, 11 |
| Init/index/sync compatibility and deleted paths | 7, 10 |
| Mutable source race retry/discard/abort rules | 8 |
| Malformed source partial facts | 2, 9 |
| Infrastructure parser/extractor failure | 9 |
| Cache read/write failure | 3, 9 |
| Legacy read-only versus mutating transition | 10 |
| Phase 13 non-mutating commands and source analysis | 10, 12 |
| Deterministic equivalence and work counters | 11, 12 |
| CLI progress and MCP/package compatibility | 7, 10, 12 |
| Exclusions from Phase 14A scope | Global Constraints, 2, 5, 6, 12 |
| Definition-of-done verification | 12 |

The matrix covers the spec's cold, unchanged, modified leaf/dependency, delete, add, same-content rename, module move, revert, version-bump, corrupt-cache, syntax-error, infrastructure-failure, source-race, interruption, removed-import, repeated-index, uncertain-fallback, legacy read-only/mutation, and fresh-versus-cache equivalence scenarios through Tasks 3, 5, 7, 8, 9, 10, and 11.

## Type, scope, and ordering review

- Task 1 introduces every shared fact/version type used by Tasks 2–11 and forbids blind reuse of path-owned graph DTOs. Task 3 introduces blob codec/cache contracts only. Task 4 introduces generation-scoped bindings/graph/derived ownership, global reference-safe GC, dual legacy/v2 reads, and generation/manifest contracts before Task 7 publication. Task 5 introduces `InvalidationPlan` before pipeline integration. Task 7 introduces the unified `IndexRunOutcome` before Tasks 8–10 add expected failure branches. Task 11 introduces `IndexWorkCounters` before final result assertions.
- Existing option types remain the base for graph, lexical, semantic, and pipeline APIs; adapters add facts as explicit inputs rather than creating parallel capability-specific contracts.
- The only new persistence is in existing Atlas SQLite schema/store conventions. No new engine, binary codec, background service, or public command is planned.
- `src/core/change/transient-graph.ts` is not a production modification target. Its Phase 13 source snapshot behavior remains independently testable.
- Scope review confirms no resolver-v2 inference, semantic invalidation, framework resolver registry, watcher, daemon, embedding expansion, global identity redesign, or native storage rewrite appears in the implementation tasks.

## Commit strategy and execution boundary

After the user authorizes execution of this plan, each task ends with one focused local commit using the intent shown in its final step; that execution authorization covers these task-scoped local commits only. The implementation agent must stage only task-owned paths and inspect `git diff --cached --name-only` before committing. The existing dirty `package.json` must never be staged with Phase 14A work. Push, merge, branch changes, amend/rewrite, and any unrelated commit remain unauthorized unless separately requested.

This document is the only requested artifact for the current turn. The implementation tasks above are not being started by this planning task; execution can later use `superpowers:subagent-driven-development` or `superpowers:executing-plans`.

## Plan self-review gates

- [ ] Read the approved design spec and map every major requirement in the coverage table above.
- [ ] Run a scan for prohibited vague instruction vocabulary; expected result is zero matches.
- [ ] Verify later-task symbols are introduced in an earlier task and every test names a concrete fixture or assertion.
- [ ] Verify only the approved plan file is changed, `package.json` remains unstaged, and the plan itself does not start implementation.

## Appendix: Detailed single-parse integration notes

**Purpose**

Make a fact cache miss the only reason the mutating index path invokes Tree-sitter. Graph construction consumes MaterializedFileFacts; lexical indexing consumes the same facts plus source text for document content; semantic indexing consumes the same facts plus its existing embedding text path.

**Files**

- Modify: `src/core/graph/build-graph.ts`, `src/core/graph/build-file-updates.ts`, `src/core/graph/graph-index.service.ts`, `src/core/lexical/lexical-index.service.ts`, `src/core/semantic/semantic-index.service.ts`, `src/core/indexing/indexing.types.ts`.
- Test: `test/phase14a-single-parse.test.ts`, `test/phase14a-equivalence.test.ts`.

**Interfaces**

- Consumes: `MaterializedFileFacts`, source text when document or embedding content requires it, `InvalidationPlan`, and the current `CodeGraph`/resolution APIs.
- Produces:

  ```ts
  export type IndexedSourceUnit = { relativePath: string; source: string; facts: ParsedFactsBlob };
  export function buildCodeGraphWithResolutionFromFacts(repoPath: string, units: IndexedSourceUnit[], reporter?: ProgressReporter, repositoryId?: string): Promise<GraphBuildResult>;
  export function buildFileGraphsFromFacts(repoPath: string, repoId: string, units: IndexedSourceUnit[], allRepoFiles: Set<string>, baseGraph: CodeGraph, reporter?: ProgressReporter): Promise<BuiltFileGraph[]>;
  export function toLexicalDocumentsFromFacts(repositoryId: string, unit: IndexedSourceUnit): LexicalDocument[];
  ```

- Keep the resolver invocation after facts materialization. Adapt existing call/member/extends routines to receive structural call sites and binding seeds; retain `parseCodeSymbols` only for the separate Phase 13 transient path until the indexing migration is complete.

**Behavioral invariants**

- For the mutating index lifecycle, Tree-sitter invocation count equals fact cache misses, not graph parse count plus lexical parse count.
- Existing graph nodes, imports, calls, extends relations, evidence, and unique-or-drop resolution semantics remain equivalent for clean fixtures.
- Lexical and semantic indexes do not invoke Tree-sitter merely to obtain chunks; their current content/embedding behavior remains in scope.

- [ ] Step 1: Instrument the parser factory with a test-only counter and add a cold/unchanged/one-file-modified run asserting parser calls equal misses.
- [ ] Step 2: Run `node --import tsx/esm --test test/phase14a-single-parse.test.ts`; confirm the counter fails because each capability still parses independently.
- [ ] Step 3: Thread `IndexedSourceUnit` through graph builders and replace lexical/semantic `parseCodeSymbols` calls with facts-to-document/chunk conversion; preserve source text for `splitLargeSymbol` and embedding text.
- [ ] Step 4: Rerun the focused single-parse test and the clean graph equivalence fixture; confirm one parse per miss and zero parse for compatible reuse.
- [ ] Step 5: Run `node --import tsx/esm --test test/graph.test.ts test/phase3-lexical.test.ts test/phase14a-equivalence.test.ts`; confirm graph, FTS, and semantic preparation regressions are green.
- [ ] Step 6: Run `npx tsc --noEmit`; inspect imports to ensure `src/core/change/transient-graph.ts` retains its independent read-only parsing path.
- [ ] Step 7: Commit with `git add src/core/graph/build-graph.ts src/core/graph/build-file-updates.ts src/core/graph/graph-index.service.ts src/core/lexical/lexical-index.service.ts src/core/semantic/semantic-index.service.ts src/core/indexing/indexing.types.ts test/phase14a-single-parse.test.ts test/phase14a-equivalence.test.ts && git commit -m "perf(index): reuse parsed facts across indexing"`.

## Appendix: Detailed lifecycle integration notes

**Purpose**

Replace the current capability-by-capability lifecycle with one mutating repository flow that captures the manifest, plans invalidation, parses misses, reuses compatible facts, resolves the selected scope, prepares derived outputs, and publishes one candidate while keeping CLI and MCP commands unchanged.

**Files**

- Modify: `src/core/indexing/index-pipeline.service.ts`, `src/core/indexing/filesystem-change-detector.ts`, `src/core/indexing/indexing.types.ts`, `src/core/graph/graph-index.service.ts`, `src/core/lexical/lexical-index.service.ts`, `src/core/semantic/semantic-index.service.ts`, `src/core/repository/index-version.ts`, `src/storage/atlas/atlas.store.ts`.
- Test: `test/phase14a-indexing.test.ts`, `test/phase4-index-pipeline.test.ts`, `test/phase11-integration.test.ts`.

**Interfaces**

- Consumes: existing `indexRepository`/`syncRepository` options, current repository files, source capture/hash results, `IndexVersionDomains`, and `planInvalidation`.
- Produces:

  ```ts
  export type PublishedIndexRun = { kind: "published"; repositoryId: string; generationId: string; plan: InvalidationPlan; published: true };
  export type FailedIndexRun = { kind: "failed"; repositoryId: string; activeGenerationId?: string; published: false; failure: IndexFailure };
  export type IndexRunOutcome = PublishedIndexRun | FailedIndexRun;
  export async function indexRepository(repoPath: string, options?: IndexPipelineOptions): Promise<IndexRunOutcome>;
  export async function syncRepository(repoPath: string, options?: IndexPipelineOptions): Promise<IndexRunOutcome>;
  ```

- Preserve the existing `init`, `index`, and `sync` CLI/MCP argument and exit behavior. Expected lifecycle failures use the `IndexRunOutcome` failure branch internally and are mapped back to existing external error/exit behavior. Add counters to internal results/progress data only; do not add a public fact/cache command.

**Behavioral invariants**

- Lifecycle order is capture/hash -> invalidation plan -> cache lookup/reparse -> candidate fact bindings -> planned or broad resolution -> graph/lexical plus enabled optional derived updates -> candidate validation -> atomic publication. Disabled/unavailable semantic indexing retains existing capability semantics and is not promoted to a mandatory publication dependency.
- Deleted paths remove stale graph nodes/edges and their fact bindings from the candidate. Repeated indexing with no source change has no fact parse work.
- A graph version/resolution compatibility decision never causes lexical or semantic code to bypass the shared fact materialization.

- [ ] Step 1: Add integration tests for cold `init`, unchanged second `index`, modified leaf, modified dependency, deletion, repeated `sync`, and CLI/MCP-compatible completion fields.
- [ ] Step 2: Run `node --import tsx/esm --test test/phase14a-indexing.test.ts test/phase4-index-pipeline.test.ts`; confirm the old separate lifecycle does not yet produce one generation/result.
- [ ] Step 3: Orchestrate one pipeline-owned `IndexRunOutcome`; pass one `IndexedSourceUnit` set to graph, lexical, and semantic consumers and stage all candidate outputs through the generation store APIs.
- [ ] Step 4: Rerun the integration tests and confirm active generation changes once per successful run and deleted paths disappear from the candidate graph.
- [ ] Step 5: Run `node --import tsx/esm --test test/phase4-index-pipeline.test.ts test/phase10-mcp.test.ts test/phase11-integration.test.ts`; confirm existing surface contracts remain green.
- [ ] Step 6: Run `npx tsc --noEmit`; inspect that no pipeline path calls a capability-specific publish before candidate validation.
- [ ] Step 7: Commit with `git add src/core/indexing/index-pipeline.service.ts src/core/indexing/filesystem-change-detector.ts src/core/indexing/indexing.types.ts src/core/graph/graph-index.service.ts src/core/lexical/lexical-index.service.ts src/core/semantic/semantic-index.service.ts src/core/repository/index-version.ts src/storage/atlas/atlas.store.ts test/phase14a-indexing.test.ts test/phase4-index-pipeline.test.ts test/phase11-integration.test.ts && git commit -m "feat(index): integrate incremental fact reuse"`.

## Appendix: Detailed source-race notes

**Purpose**

Ensure a mutable working tree cannot produce a mixed-generation graph. Capture/hash before extraction and after extraction; discard and retry one time on a changed source, then abort the candidate while retaining the active generation.

**Files**

- Modify: `src/core/indexing/filesystem-change-detector.ts`, `src/core/indexing/index-pipeline.service.ts`, `src/storage/atlas/atlas.store.ts`.
- Test: `test/phase14a-races.test.ts`, `test/phase14a-generation.test.ts`.

**Interfaces**

- Consumes: the existing filesystem reader/hash mechanism, an injectable source reader, and the canonical fact extractor.
- Produces:

  ```ts
  export type SourceRead = { source: string; contentHash: string };
  export type SourceReader = (relativePath: string) => Promise<SourceRead>;
  export type StableFactExtraction = { source: string; facts: ParsedFactsBlob };
  export async function extractStableFacts(relativePath: string, reader: SourceReader, extractor: (read: SourceRead) => FactExtractionOutcome, maxAttempts?: number): Promise<StableFactExtraction>;
  ```

- `extractStableFacts` performs `before read -> extraction -> after read` on every attempt and compares the before/after content hashes only after extraction completes. A mismatch discards both the source/facts candidate and retries once. After the second mismatch it returns/maps a typed source-race failure through `IndexRunOutcome` without touching the active pointer.

**Behavioral invariants**

- One source race causes one retry only. The second race never publishes N+1 and leaves N active.
- Candidate bindings, manifest, graph, and derived outputs are isolated from the active generation until the atomic pointer transaction.
- Tests use deterministic reader sequences and transaction fault injection; no sleep, wall-clock polling, or file-watcher behavior is introduced.

- [ ] Step 1: Add deterministic tests where the reader/extractor sequence proves the after-hash read occurs after extraction: one mismatch followed by a stable retry, two mismatches, and a TOCTOU regression where two pre-extraction reads would appear stable but content changes during extraction. Assert extraction count, retry count, active ID, and error classification.
- [ ] Step 2: Run `node --import tsx/esm --test test/phase14a-races.test.ts`; confirm no post-extraction stability seam and no typed race outcome exist.
- [ ] Step 3: Implement `extractStableFacts` and route pipeline extraction through it; make publication refuse a candidate with any source-race/infrastructure failure outcome.
- [ ] Step 4: Rerun race and generation tests; confirm the first race retries and the second race preserves N.
- [ ] Step 5: Run `node --import tsx/esm --test test/phase14a-indexing.test.ts test/phase14a-generation.test.ts`; confirm ordinary runs still publish.
- [ ] Step 6: Run `npx tsc --noEmit` and inspect transaction rollback paths for active-pointer writes.
- [ ] Step 7: Commit with `git add src/core/indexing/filesystem-change-detector.ts src/core/indexing/index-pipeline.service.ts src/storage/atlas/atlas.store.ts test/phase14a-races.test.ts test/phase14a-generation.test.ts && git commit -m "fix(index): guard source generation publication"`.

## Appendix: Detailed failure-semantics notes

**Purpose**

Make failure classes explicit. A deterministic partial parse may be cached with diagnostics and may publish an incomplete candidate; an infrastructure parser/extractor exception, corrupt cache, or cache-write failure cannot publish authoritative facts or N+1.

**Files**

- Modify: `src/core/facts/facts-extractor.ts`, `src/core/facts/facts-codec.ts`, `src/core/indexing/index-pipeline.service.ts`, `src/storage/atlas/atlas.store.ts`, `src/core/graph/build-graph.ts`.
- Test: `test/phase14a-failures.test.ts`, `test/phase14a-cache.test.ts`.

**Interfaces**

- Consumes: Tree-sitter parse diagnostics, extractor exceptions, `FactCacheLookup`, and candidate transaction errors.
- Produces:

  ```ts
  export type FactExtractionOutcome = { kind: "facts"; facts: ParsedFactsBlob } | { kind: "infrastructure_failure"; error: Error };
  export type IndexFailure = { kind: "source_race" | "infrastructure_failure" | "cache_write_failure"; message: string; activeGenerationId?: string };
  export function extractParsedFacts(input: FactExtractionInput): FactExtractionOutcome;
  // Expected lifecycle failures are returned by IndexRunOutcome.kind === "failed"; CLI/MCP adapt them to existing external failure behavior.
  ```

- Preserve the existing parser-error check as diagnostics on a deterministic partial result; reserve `infrastructure_failure` for parser/adapter/extractor exceptions or impossible fact validation.

**Behavioral invariants**

- Malformed user source with a deterministic partial tree yields `parseStatus="deterministic_partial"`, persisted diagnostics, downstream incomplete state, and reuse on an unchanged subsequent index.
- Infrastructure parser/extractor failure yields no authoritative blob, aborts N+1, leaves N active, reports failure/incomplete, and performs no read-only repair.
- Corrupt cache is a miss and is safely repaired only by a successful mutating reparse. Cache-write failure aborts publication rather than leaving bindings pointing to absent/inconsistent payload.

- [ ] Step 1: Add tests for malformed source partial publication/reuse, injected parser exception, invalid cache repair, and injected cache-write failure with active-generation assertions.
- [ ] Step 2: Run `node --import tsx/esm --test test/phase14a-failures.test.ts`; confirm failure classes are not yet distinct.
- [ ] Step 3: Implement the discriminated outcomes, diagnostics persistence, candidate rollback, and cache-write atomicity; keep read-only stores from invoking repair paths.
- [ ] Step 4: Rerun the failure tests and assert exactly which paths may publish and which must retain N.
- [ ] Step 5: Run `node --import tsx/esm --test test/phase14a-cache.test.ts test/phase14a-indexing.test.ts test/graph.test.ts`; confirm cache and graph regressions remain green.
- [ ] Step 6: Run `npx tsc --noEmit`; inspect that no exception is converted into an authoritative empty fact blob.
- [ ] Step 7: Commit with `git add src/core/facts/facts-extractor.ts src/core/facts/facts-codec.ts src/core/indexing/index-pipeline.service.ts src/storage/atlas/atlas.store.ts src/core/graph/build-graph.ts test/phase14a-failures.test.ts test/phase14a-cache.test.ts && git commit -m "fix(index): harden parsed fact failure semantics"`.
