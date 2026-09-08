# Phase 14B-5 Conformance and Regression Closure Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Assemble the complete Phase14B pipeline, prove incremental/generation equivalence, and close every language, regression, packaging, and MCP gate.

**Architecture:** The pipeline parses only `parsePaths`, reuses compatible fact blobs for `reusePaths`, resolves only the safe bounded scope or the full repository fallback, and assembles every current file into a complete candidate graph. Logical identities rebind carried-forward semantic state; raw active-generation row IDs never cross the generation boundary.

**Tech Stack:** TypeScript 7.0.2, Node 22, pnpm 11.22.0, SQLite/WAL, existing CLI/MCP entry points, `node:test`, npm packed tarballs.

**Spec:** [Phase14B revised design](<HOME>/code-atlas/docs/superpowers/specs/2026-09-07-phase14b-multilanguage-resolver-typeenvironment-v2-design.md), §§22–27, 30, 37–51.

## Global Constraints

- A candidate generation is complete even when resolution work is bounded.
- `parsePaths`, `reusePaths`, and `resolvePaths` are both observable and honored.
- Resolution-version change: `parsedFiles = 0`, all resolution-capable files resolve, and no old-resolution-version edge is carried forward.
- Safe bounded resolution includes changed files and direct importers; uncertain imports, moves, renames, module configuration changes, export ambiguity, incomplete provenance, broad facts changes, and resolution-version changes use repository-wide resolution.
- Candidate failure leaves the active generation unchanged.
- Semantic equivalence ignores DB row IDs, generation IDs, timestamps, durations, temporary paths, and memo hit/miss counters; it compares logical nodes, edges, decisions, provenance, diagnostics, and incompleteness.
- Do not change public CLI/MCP command names or add Phase14D presentation surfaces.

### Task 5.1: Integrate resolution scope into the unified indexing pipeline

**Files:**
- Modify: `src/core/indexing/index-pipeline.service.ts`
- Modify: `src/core/indexing/filesystem-change-detector.ts`
- Modify: `src/core/indexing/indexing.types.ts`
- Test: `test/phase14b-pipeline-scope.test.ts`
- Modify: `test/phase14a-indexing.test.ts` (counter compatibility)

**Interfaces:**
- `indexRepository(repoPath: string, options?: IndexPipelineOptions): Promise<IndexRunOutcome>` and `syncRepository(repoPath: string, options?: IndexPipelineOptions): Promise<IndexRunOutcome>` remain public entry points.
- The pipeline passes `CandidateResolutionInput` from Track14B-0 to the facts resolver from Track14B-2.
- `IndexWorkCounters` exposes `filesParsed`, `factCacheHits`, `factCacheMisses`, `filesResolved`, `importersInvalidated`, and `fullResolutionFallbacks` with deterministic meanings.
- Owns `buildPipelineResolverContext(input: { generationId: string; repositoryIdentity: RepositoryIdentity; facts: readonly ParsedFactsBlob[]; adapters: readonly LanguageSemanticAdapter[]; resolutionVersion: string }): GenerationResolverContext`; it creates one budget ledger/memo/environment for the candidate generation using Track 14B-2 APIs.

- [ ] **Step 1: Write the failing test**

```ts
test("pipeline resolves only changed file and direct importer while retaining unrelated graph state", async () => {
  const fixture = await createDependencyFixture();
  await indexRepository(fixture.root, { skipGit: true });
  await writeFile(fixture.dependency, changedDependencySource());
  const result = await syncRepository(fixture.root, { skipGit: true });
  assert.equal(result.kind, "published");
  assert.deepEqual(result.plan.resolvePaths, ["src/consumer.ts", "src/dep.ts"]);
  assert.equal(result.counters.filesParsed, 1);
  assert.equal(result.counters.filesResolved, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-pipeline-scope.test.ts`

Expected: FAIL because `index-pipeline.service.ts` resolves all units whenever it rebuilds and does not pass a resolution scope.

- [ ] **Step 3: Implement scoped resolution with complete candidate assembly**

Reuse cached facts for all compatible files, parse only `plan.parsePaths`, build evidence/environment from all candidate facts, resolve `scope.paths`, logically rebind safe unaffected edges, and use repository-wide resolution for unsafe scope. Write all candidate graph nodes/edges and generation-scoped diagnostics before publication.

```ts
const scope = createResolutionScope(plan);
const candidateInput = createCandidateResolutionInput(allUnits, scope, activeGenerationId, activeGraph);
const resolverContext = buildPipelineResolverContext({ generationId, repositoryIdentity, facts: candidateInput.allUnits.map((unit) => unit.facts), adapters: allSemanticAdapters(), resolutionVersion: CURRENT_INDEX_VERSION_DOMAINS.resolutionVersion });
const graph = await buildCodeGraphWithResolutionFromFacts(repoPath, candidateInput.allUnits, reporter, repositoryId, candidateInput.scope.paths, resolverContext);
await store.writeCandidateGraph(generationId, graph.graph, fileHashes, graph.resolutionByFile);
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-pipeline-scope.test.ts test/phase14a-indexing.test.ts test/phase14a-single-parse.test.ts`

Expected: PASS for bounded parse/resolve counters, complete candidate graph, cache reuse, importer invalidation, and existing Phase14A counters.

- [ ] **Step 5: Commit**

```bash
git add src/core/indexing/index-pipeline.service.ts src/core/indexing/filesystem-change-detector.ts src/core/indexing/indexing.types.ts test/phase14b-pipeline-scope.test.ts test/phase14a-indexing.test.ts
git commit -m "feat(index): honor Phase 14B resolution scopes"
```

### Task 5.2: Implement logical carry-forward and unsafe topology fallback

**Files:**
- Modify: `src/core/indexing/index-pipeline.service.ts`
- Modify: `src/core/graph/build-file-updates.ts`
- Modify: `src/core/indexing/invalidation-planner.ts`
- Test: `test/phase14b-incremental-equivalence.test.ts`
- Modify: `test/phase14a-equivalence.test.ts` (normalized graph comparison)

**Interfaces:**
- Produces `type CandidateSymbolBinding = { identity: SymbolIdentity; graphNodeId: string }`; `graphNodeId` is the candidate in-memory `CodeGraph` node ID, never an Atlas row ID.
- Produces `rebindCandidateEdges(previousGraph: CodeGraph, candidateSymbols: readonly CandidateSymbolBinding[], resolutionVersion: string): GraphEdge[]` that returns only Phase14B semantic edges whose persisted provenance endpoint keys resolve uniquely in the candidate.
- Produces `requiresRepositoryResolution(plan: InvalidationPlan): boolean` for unresolved imports, moves/renames, module configuration changes, export ambiguity, incomplete provenance, broad facts changes, and resolution-version changes.
- No function copies raw SQLite IDs from active generation into a candidate.
- Test-local helpers are declared in `test/phase14b-incremental-equivalence.test.ts`: `createEquivalenceFixture(): Promise<EquivalenceFixture>`; `applySafeDependencyChange(fixture: EquivalenceFixture): Promise<void>`; `applyRenamedModuleWithUnknownExport(fixture: EquivalenceFixture): Promise<void>`; `normalizedGraphMatchesCleanRebuild(root: string): Promise<boolean>`.

- [ ] **Step 1: Write the failing test**

```ts
test("incremental normalized graph equals clean rebuild after safe change, rename, and unsafe move", async () => {
  const fixture = await createEquivalenceFixture();
  await indexRepository(fixture.root, { skipGit: true });
  await applySafeDependencyChange(fixture);
  const safe = await syncRepository(fixture.root, { skipGit: true });
  assert.equal(safe.kind, "published");
  assert.equal(await normalizedGraphMatchesCleanRebuild(fixture.root), true);
  await applyRenamedModuleWithUnknownExport(fixture);
  const unsafe = await syncRepository(fixture.root, { skipGit: true });
  assert.equal(unsafe.kind, "published");
  assert.equal(unsafe.plan.fullGraphResolution, true);
  assert.equal(unsafe.counters.filesParsed, 0);
  assert.equal(await normalizedGraphMatchesCleanRebuild(fixture.root), true);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-incremental-equivalence.test.ts`

Expected: FAIL because carried-forward graph rows are not logically rebound and unsafe topology does not consistently expand resolution.

- [ ] **Step 3: Implement identity-based carry-forward and fallback**

Build `CandidateSymbolBinding` values from candidate facts plus the newly assembled candidate graph. Rebind only one-to-one endpoint matches using `edge.resolution.sourceLogicalIdentity` / `targetLogicalIdentity` persisted by Track 14B-4; invalidate edges whose owner/module/export identity changed, and expand scope to every current resolution-capable unit for unsafe cases. Preserve complete contains/import graph structure independently of semantic resolution.

```ts
export function rebindCandidateEdges(previousGraph: CodeGraph, candidateSymbols: readonly CandidateSymbolBinding[], resolutionVersion: string): GraphEdge[] {
  const byIdentity = new Map(candidateSymbols.map(({ identity, graphNodeId }) => [symbolIdentityKey(identity), graphNodeId] as const));
  return previousGraph.edges.flatMap((edge) => {
    const resolution = edge.resolution;
    if (!resolution || resolution.resolutionVersion !== resolutionVersion) return [];
    const source = byIdentity.get(resolution.sourceLogicalIdentity);
    const target = byIdentity.get(resolution.targetLogicalIdentity);
    return source && target ? [{ ...edge, source, target }] : [];
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-incremental-equivalence.test.ts test/phase14a-equivalence.test.ts test/phase14a-invalidation.test.ts`

Expected: PASS for safe bounded equivalence, rename/move fallback, removed imports, deleted files, and clean full rebuild equality.

- [ ] **Step 5: Commit**

```bash
git add src/core/indexing/index-pipeline.service.ts src/core/graph/build-file-updates.ts src/core/indexing/invalidation-planner.ts test/phase14b-incremental-equivalence.test.ts test/phase14a-equivalence.test.ts
git commit -m "feat(index): safely rebind incremental semantic edges"
```

### Task 5.3: Add resolution-version rebuild and candidate-failure isolation

**Files:**
- Modify: `src/core/indexing/index-pipeline.service.ts`
- Test: `test/phase14b-resolution-version.test.ts`
- Test: `test/phase14b-candidate-failure.test.ts`
- Modify: `test/phase14a-failures.test.ts` (candidate rollback regression)
- Modify: `test/phase14a-races.test.ts` (candidate race regression)

**Interfaces:**
- A `CURRENT_INDEX_VERSION_DOMAINS.resolutionVersion` change causes `planInvalidation` to return empty `parsePaths`, all current resolution-capable `resolvePaths`, and `fullGraphResolution: true`.
- `IndexRunOutcome` remains the existing discriminated union; failures return `kind: "failed"` with `published: false` and `activeGenerationId`.
- Test-local helpers are declared in their owning tests: `createIndexedFixture(): Promise<IndexedFixture>`; `runWithResolutionVersion(fixture: IndexedFixture, version: string): Promise<IndexRunOutcome>`; `IndexedFixture.allSemanticEdgesUseVersion(version: string): Promise<boolean>`; `IndexedFixture.activeSnapshot(): Promise<unknown>`; `IndexedFixture.failCandidateGraphWrite(): void`.

- [ ] **Step 1: Write the failing tests**

```ts
test("resolution-version bump reuses facts and emits only current-version edges", async () => {
  const fixture = await createIndexedFixture();
  const result = await runWithResolutionVersion(fixture, "1.0.1");
  assert.equal(result.kind, "published");
  assert.equal(result.counters.filesParsed, 0);
  assert.equal(result.plan.fullGraphResolution, true);
  assert.equal(await fixture.allSemanticEdgesUseVersion("1.0.1"), true);
});

test("candidate failure leaves active generation unchanged", async () => {
  const fixture = await createIndexedFixture();
  const before = await fixture.activeSnapshot();
  fixture.failCandidateGraphWrite();
  const result = await syncRepository(fixture.root, { skipGit: true });
  assert.equal(result.kind, "failed");
  assert.deepEqual(await fixture.activeSnapshot(), before);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx/esm --test test/phase14b-resolution-version.test.ts test/phase14b-candidate-failure.test.ts`

Expected: FAIL because the current pipeline conflates graph/resolution versions and does not prevent old-version semantic carry-forward in the candidate path.

- [ ] **Step 3: Implement independent resolution rebuild and failure handling**

Use the independent resolution version in cache planning and edge provenance, rebuild the transient environment from cached facts, clear candidate semantic rows before writing current results, and rely on the existing `AtlasStore.writeCandidateGraph` transaction so active state remains unchanged on any failure. No storage file is modified in this task.

```ts
const resolutionVersion = CURRENT_INDEX_VERSION_DOMAINS.resolutionVersion;
const plan = planInvalidation(manifest, changes, { resolutionVersion });
const result = await buildCodeGraphWithResolutionFromFacts(repoPath, allUnits, reporter, repositoryId, plan.resolvePaths, {
  ...resolverContext,
  resolutionVersion,
});
await store.writeCandidateGraph(generationId, result.graph, fileHashes, result.resolutionByFile);
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx/esm --test test/phase14b-resolution-version.test.ts test/phase14b-candidate-failure.test.ts test/phase14a-failures.test.ts test/phase14a-races.test.ts`

Expected: PASS for zero-parse resolution rebuild, old-version exclusion, candidate rollback, source race, cache-write failure, and active-generation preservation.

- [ ] **Step 5: Commit**

```bash
git add src/core/indexing/index-pipeline.service.ts test/phase14b-resolution-version.test.ts test/phase14b-candidate-failure.test.ts test/phase14a-failures.test.ts test/phase14a-races.test.ts
git commit -m "feat(index): isolate resolution-version candidate rebuilds"
```

### Task 5.4: Run language conformance and complete regression gates

**Files:**
- Create: `test/phase14b-conformance.test.ts`
- Create: `test/phase14b-packed-mcp-smoke.test.ts`
- Create: `test/helpers/phase14b-conformance.ts`
- Modify: `test/phase14a-equivalence.test.ts` only if its normalization must include declared Phase14B provenance fields

**Interfaces:**
- `type FixtureResult = LanguageFixtureResult & { normalizedEdges: readonly unknown[]; diagnostics: readonly ResolverDiagnostic[]; counters: Readonly<Record<string, number>>; mayBeIncomplete: boolean; expected: Phase14bExpectedFixture }`.
- `type Phase14bExpectedFixture = { normalizedEdges: readonly unknown[]; decisions: readonly unknown[] }`.
- `loadPhase14bExpectedFixture(name: string): Promise<Phase14bExpectedFixture>` reads `test/fixtures/phase14b/<name>/expected.json`.
- `runPhase14bFixture(name: string, options?: { memoMode?: "cold" | "warm"; parallel?: boolean }): Promise<FixtureResult>` resolves concrete extractors/adapters through the completed Task 3.10 registries, delegates syntax/resolver work to `runLanguageFixture`, then adds persisted edge/diagnostic/counter normalization for conformance comparison.
- Every fixture’s `expected.json` is checked for terminal decisions, accepted edges, strategy/confidence, bounded evidence kinds, and unsupported/ambiguity/unknown/budget outcomes.
- `readJsonLine(stream: NodeJS.ReadableStream): Promise<Record<string, any>>` reads exactly one newline-delimited JSON object and rejects on EOF/invalid JSON.
- `runPackedMcpInitialize(cliPath: string): Promise<{ protocolVersion: string; serverName: string }>` spawns `node cliPath mcp`, sends one MCP `initialize` request, reads the first response with `readJsonLine`, verifies the JSON response, and closes the child.
- Low-level fact fixtures remain owned by `test/helpers/phase14b-facts.ts`; language fixtures remain owned by `test/helpers/phase14b-language-fixtures.ts`; this task owns only the conformance runner.

- [ ] **Step 1: Write the failing tests**

```ts
test("all target-language fixtures satisfy the applicable semantic floor", async () => {
  for (const language of targetLanguages) {
    const result = await runPhase14bFixture(language);
    assert.equal(result.floorPassed, true, language);
    assert.deepEqual(result.normalizedEdges, result.expected.normalizedEdges);
    assert.deepEqual(result.decisions, result.expected.decisions);
  }
});

test("packed CLI initializes MCP over stdio", async () => {
  const response = await runPackedMcpInitialize(process.env.PACKED_CLI_PATH!);
  assert.equal(typeof response.protocolVersion, "string");
  assert.equal(response.serverName, "code-atlas");
});
```

- [ ] **Step 2: Run focused tests to verify they fail**

Run: `node --import tsx/esm --test test/phase14b-conformance.test.ts test/phase14b-packed-mcp-smoke.test.ts`

Expected: FAIL because the conformance fixture runner and packed MCP smoke do not exist.

- [ ] **Step 3: Implement executable fixture and packaging checks**

Create fixtures for local binding, imports/re-exports, construction, assignment, parameter/return flow, member/receiver, inheritance/interface/trait/protocol/implementation, aliases, ambiguity, unknown, unsupported, budget, and deterministic repeated/cold/warm/parallel execution. Normalize away only the fields declared in §41.1. Keep fixture helpers independent from source-text semantic resolution.

```ts
export async function readJsonLine(stream: NodeJS.ReadableStream): Promise<Record<string, any>> {
  let buffer = "";
  for await (const chunk of stream) {
    buffer += String(chunk);
    const newline = buffer.indexOf("\n");
    if (newline >= 0) return JSON.parse(buffer.slice(0, newline)) as Record<string, any>;
  }
  throw new Error("MCP process ended before emitting a JSON line");
}

export async function runPackedMcpInitialize(cliPath: string): Promise<{ protocolVersion: string; serverName: string }> {
  const child = spawn(process.execPath, [cliPath, "mcp"], { stdio: ["pipe", "pipe", "inherit"] });
  child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "phase14b-smoke", version: "1" } } })}\n`);
  const response = await readJsonLine(child.stdout);
  child.kill();
  return { protocolVersion: response.result.protocolVersion, serverName: response.result.serverInfo.name };
}
```

- [ ] **Step 4: Run focused tests to verify they pass**

Run: `node --import tsx/esm --test test/phase14b-conformance.test.ts test/phase14b-packed-mcp-smoke.test.ts test/phase14b-language-*.test.ts`

Expected: PASS for all eleven semantic language floors, TSX parser variant, decision categories, provenance, diagnostics, and packed MCP initialization.

- [ ] **Step 5: Run the exact repository regression matrix**

Run:

```bash
pnpm run build
pnpm test
pnpm run lint
pnpm exec tsc --noEmit
pnpm run ui:typecheck
node --import tsx/esm --test test/phase14b-*.test.ts
node --import tsx/esm --test test/phase14a-*.test.ts
node --import tsx/esm --test test/phase13-remediation.test.ts test/phase14a-readonly.test.ts test/capability-state-regression.test.ts test/phase12-cli-regression.test.ts test/phase10-mcp.test.ts test/phase11-integration.test.ts
git diff --check
```

Expected: every command exits 0; focused and regression test output reports no failures.

- [ ] **Step 6: Run packed npm/pnpm and MCP smoke checks**

Run:

```bash
pack_dir="$(mktemp -d)"
npm pack --pack-destination "$pack_dir"
tarball="$(find "$pack_dir" -maxdepth 1 -name 'code-atlas-*.tgz' -print -quit)"
npm_dir="$(mktemp -d)"
npm install --prefix "$npm_dir" "$tarball"
node "$npm_dir/node_modules/code-atlas/dist/cli.js" --help
pnpm_dir="$(mktemp -d)"
pnpm add --dir "$pnpm_dir" "$tarball"
node "$pnpm_dir/node_modules/code-atlas/dist/cli.js" --help
PACKED_CLI_PATH="$npm_dir/node_modules/code-atlas/dist/cli.js" node --import tsx/esm --test test/phase14b-packed-mcp-smoke.test.ts
```

Expected: `npm pack --pack-destination` includes `dist`, both installs succeed, both compiled CLIs print the existing usage surface, and MCP initialize returns a valid `code-atlas` server response.

- [ ] **Step 7: Commit the closure tests only after all gates pass**

```bash
git add test/phase14b-conformance.test.ts test/phase14b-packed-mcp-smoke.test.ts test/helpers/phase14b-conformance.ts test/phase14a-equivalence.test.ts
git commit -m "test: close Phase 14B conformance and regression gates"
```

## Track checkpoint

Track 14B-5 is complete only when the unified pipeline honors all three paths, safe and unsafe incremental cases equal clean rebuilds, resolution-version rebuild parses zero files, failed candidates leave active state unchanged, all target-language floors pass, the full regression matrix is green, packed npm/pnpm installs work, MCP initializes from the packed CLI, and `git diff --check` passes.
