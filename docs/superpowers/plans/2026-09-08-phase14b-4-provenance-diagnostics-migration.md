# Phase 14B-4 Provenance, Diagnostics, and Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist accepted Phase14B edge provenance and bounded resolver diagnostics while preserving legacy readability and strict read-only behavior.

**Architecture:** Add a Phase14B provenance value to graph edges and generation rows, keep legacy numeric fields readable without converting them into categorical evidence, and migrate only in mutating AtlasStore initialization. Store candidate diagnostics with the candidate generation so active state remains untouched until publication.

**Tech Stack:** TypeScript 7.0.2, Node 22 `node:sqlite`, existing `AtlasStore`, SQLite schema helpers, `node:test`.

**Spec:** [Phase14B revised design](<HOME>/code-atlas/docs/superpowers/specs/2026-09-07-phase14b-multilanguage-resolver-typeenvironment-v2-design-revised.md), §§15–17, 31–34, 46–51.

## Global Constraints

- Accepted edges persist strategy, categorical confidence, compact bounded evidence provenance, and `resolutionVersion`.
- Legacy numeric confidence remains readable where required but is never threshold-converted into new `exact` or `strong` evidence.
- Read-only AtlasStore opening performs zero schema migration, table creation, metadata write, fact repair, candidate publication, or timestamp write.
- Diagnostics are correctness/coverage primitives only: `resolved`, `ambiguous`, `unknown`, `unsupported`, `budgetExhausted`, `weakEvidenceDropped`, and `candidateOverflow`.
- Bounded aggregates remain generation-scoped and preserve `mayBeIncomplete`/authoritative-negative semantics.
- No dashboard, telemetry UI, marketing score, or Phase14D presentation policy.

### Task 4.1: Define persisted provenance and diagnostic records

**Files:**
- Modify: `src/core/graph/types.ts`
- Modify: `src/core/graph/resolution.types.ts`
- Modify: `src/core/diagnostics/coverage-diagnostics.types.ts`
- Create: `src/core/graph/resolver/provenance.ts`
- Create: `src/core/diagnostics/resolver-diagnostics.ts`
- Test: `test/phase14b-provenance-diagnostics.test.ts`

**Interfaces:**
- `type ResolutionConfidence = "exact" | "strong" | "weak"`.
- `type EdgeResolutionProvenance = { strategy: string; confidence: ResolutionConfidence; evidence: readonly CompactEvidence[]; resolutionVersion: string }`.
- `type CompactEvidence = { kind: string; sourceUnit: string; startLine: number; endLine: number; evidenceId?: string }`.
- `GraphEdge` gains optional `resolution?: EdgeResolutionProvenance`; existing `confidence?: number`, `evidenceKind`, and `resolutionSource` remain legacy-readable.
- `type ResolverDiagnosticKind = "resolved" | "ambiguous" | "unknown" | "unsupported" | "budgetExhausted" | "weakEvidenceDropped" | "candidateOverflow"`.
- `type ResolverDiagnostic = { kind: ResolverDiagnosticKind; language: LanguageId; file: string; strategy?: string; edgeKind?: GraphEdgeType; count: number; reason?: string }`.

- [ ] **Step 1: Write the failing test**

```ts
test("accepted edge provenance is categorical and bounded", () => {
  const edge = edgeWithProvenance({ strategy: "receiver-member", confidence: "strong", resolutionVersion: "1.0.0" });
  assert.equal(edge.resolution?.confidence, "strong");
  assert.equal(typeof edge.confidence, "undefined");
  assert.ok((edge.resolution?.evidence.length ?? 0) <= MAX_COMPACT_EVIDENCE);
});

test("weak evidence produces a diagnostic and no accepted edge", () => {
  assert.equal(resolveWeakFixture().edges.length, 0);
  assert.equal(resolveWeakFixture().diagnostics[0]?.kind, "weakEvidenceDropped");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-provenance-diagnostics.test.ts`

Expected: FAIL because graph edges have numeric confidence only and no bounded resolver diagnostic model exists.

- [ ] **Step 3: Implement provenance and diagnostic contracts**

Validate categorical values, sort evidence deterministically, cap evidence records and reason lengths, and map each non-resolved decision to one diagnostic category. Keep legacy fields unchanged for old graph readers.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-provenance-diagnostics.test.ts test/phase7-resolution-evidence.test.ts test/coverage-diagnostics.test.ts`

Expected: PASS for new provenance/diagnostic assertions and existing numeric legacy evidence tests.

- [ ] **Step 5: Commit**

```bash
git add src/core/graph/types.ts src/core/graph/resolution.types.ts src/core/diagnostics/coverage-diagnostics.types.ts src/core/graph/resolver/provenance.ts src/core/diagnostics/resolver-diagnostics.ts test/phase14b-provenance-diagnostics.test.ts test/phase7-resolution-evidence.test.ts test/coverage-diagnostics.test.ts
git commit -m "feat(graph): define bounded Phase 14B provenance"
```

### Task 4.2: Migrate Atlas schema and generation-edge persistence

**Files:**
- Modify: `src/storage/atlas/atlas.schema.ts`
- Modify: `src/storage/atlas/atlas.store.ts`
- Modify: `src/storage/atlas/atlas.types.ts`
- Test: `test/phase14b-provenance-storage.test.ts`

**Interfaces:**
- `generation_edges` and legacy `edges` gain nullable `resolution_strategy`, `resolution_confidence`, `resolution_evidence_json`, and `resolution_version` columns; `repository_index_state` gains `active_facts_schema_version` so the six version domains remain independently readable.
- `AtlasStore.writeCandidateGraph(generationId: string, graph: CodeGraph, fileHashes: Map<string, string>, resolutionByFile?: Map<string, GraphResolutionFile>): void` persists new provenance for Phase14B edges and legacy columns for legacy edges.
- `AtlasStore.loadGraph(repositoryId: string): CodeGraph` returns categorical provenance when present and leaves it absent for legacy rows.

- [ ] **Step 1: Write the failing test**

```ts
test("candidate edge provenance survives close and reopen", () => {
  const store = openWritableFixtureStore();
  const generationId = writeCandidateWithEdge(store, edgeWithProvenance({ strategy: "constructor", confidence: "exact", resolutionVersion: "1.0.0" }));
  publishFixtureGeneration(store, generationId);
  store.close();
  const reopened = openWritableFixtureStore();
  const edge = reopened.loadGraph("repo").edges.find((item) => item.type === "calls");
  assert.deepEqual(edge?.resolution, { strategy: "constructor", confidence: "exact", evidence: edge?.resolution?.evidence, resolutionVersion: "1.0.0" });
  reopened.close();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-provenance-storage.test.ts`

Expected: FAIL because generation-edge schema and insert/load statements do not contain Phase14B provenance columns.

- [ ] **Step 3: Implement schema migration and codec boundaries**

Bump `ATLAS_SCHEMA_VERSION` from `"1"` to `"2"` and implement the explicit mutating migration from schema `"1"` to `"2"`: add the nullable provenance columns to both edge tables and `active_facts_schema_version` to `repository_index_state`, update `atlas_schema`, and reject unknown versions. Read-only construction must bypass this function completely. JSON-encode the bounded evidence array, validate it on load, and preserve null provenance for legacy rows. Keep candidate writes transaction-scoped.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-provenance-storage.test.ts test/phase14a-generation.test.ts test/phase0-storage.test.ts`

Expected: PASS for reopen round trip, atomic candidate publication, rollback, and existing Phase14A generation behavior.

- [ ] **Step 5: Commit**

```bash
git add src/storage/atlas/atlas.schema.ts src/storage/atlas/atlas.store.ts src/storage/atlas/atlas.types.ts test/phase14b-provenance-storage.test.ts test/phase14a-generation.test.ts test/phase0-storage.test.ts
git commit -m "feat(storage): persist Phase 14B edge provenance"
```

### Task 4.3: Preserve legacy rows and read-only migration guarantees

**Files:**
- Modify: `src/storage/atlas/atlas.schema.ts`
- Modify: `src/storage/atlas/atlas.store.ts`
- Modify: `src/core/diagnostics/coverage-diagnostics.service.ts`
- Test: `test/phase14b-readonly-migration.test.ts`

**Interfaces:**
- Legacy `unresolved` and `unsupportedDynamic` results map to compatibility diagnostics only; they never create new categorical accepted edges.
- `getRepositoryStatusReadOnly`, `AtlasStore` read-only construction, and graph loading leave DB/WAL/SHM bytes and timestamps unchanged.
- Coverage maps `unknown`, `unsupported`, `budgetExhausted`, `weakEvidenceDropped`, and `candidateOverflow` to incomplete coverage without claiming authoritative absence.

- [ ] **Step 1: Write the failing test**

```ts
test("read-only open does not migrate legacy provenance schema", async () => {
  const fixture = await createLegacyAtlasFixture();
  const before = await snapshotDbFiles(fixture.dbPath);
  const store = new AtlasStore(fixture.dbPath, { readOnly: true });
  assert.equal(store.loadGraph(fixture.repositoryId).edges[0]?.resolution, undefined);
  store.close();
  assert.deepEqual(await snapshotDbFiles(fixture.dbPath), before);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-readonly-migration.test.ts`

Expected: FAIL because the new migration/read-only boundary and legacy diagnostic mapping are not implemented.

- [ ] **Step 3: Implement compatibility behavior**

Route schema alterations through the mutating initialization path only. Load legacy edges with legacy fields, mark coverage incomplete where categories cannot be known, and keep existing `mayBeIncomplete`/negative authority semantics.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-readonly-migration.test.ts test/phase14a-readonly.test.ts test/phase13-remediation.test.ts test/coverage-diagnostics.test.ts`

Expected: PASS with byte/timestamp-identical read-only snapshots and compatibility diagnostics.

- [ ] **Step 5: Commit**

```bash
git add src/storage/atlas/atlas.schema.ts src/storage/atlas/atlas.store.ts src/core/diagnostics/coverage-diagnostics.service.ts test/phase14b-readonly-migration.test.ts test/phase14a-readonly.test.ts test/phase13-remediation.test.ts test/coverage-diagnostics.test.ts
git commit -m "fix(storage): preserve legacy and read-only semantics"
```

## Track checkpoint

Track 14B-4 is complete when new provenance round-trips through candidate generation, schema migration is mutating-only, legacy rows are readable without fabricated evidence, all seven diagnostic categories are bounded, and Phase13/14A read-only tests remain green.
