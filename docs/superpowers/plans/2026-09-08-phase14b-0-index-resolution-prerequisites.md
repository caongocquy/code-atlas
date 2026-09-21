# Phase 14B-0 Index and Resolution Prerequisites Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Separate version ownership and make invalidation produce a safe, explicit resolution scope for a complete candidate graph.

**Architecture:** Keep the existing `InvalidationPlan` as the planner output and add one pure scope contract consumed by the pipeline. The planner may select a bounded set only when importer provenance is complete; every unsafe topology becomes repository-wide resolution while fact parsing remains cache-driven.

**Tech Stack:** TypeScript 7.0.2, Node 22, SQLite-backed AtlasStore, `node:test`, existing `IndexManifest` and `IndexPipeline` types.

**Spec:** [Phase14B revised design](<HOME>/code-atlas/docs/superpowers/specs/2026-09-07-phase14b-multilanguage-resolver-typeenvironment-v2-design.md), §§21–27, 45, 47.

## Global Constraints

- `factsSchemaVersion`, `factsVersion`, `parserIdentity`, `resolutionVersion`, `schemaVersion`, and `derivedVersion` are independent operational domains.
- Semantic adapter changes invalidate `resolutionVersion`, never `parserIdentity`.
- A resolution-version change means zero source parses, all resolution-capable files resolved, and no old-version semantic edge carried forward.
- A candidate graph is complete; scope selection controls semantic work, not candidate graph completeness.
- Unsafe importer/module provenance expands to repository-wide resolution.
- Do not modify `package.json` or language parser modules in this track. The version-domain change owns the `IndexVersionDomains` declaration because every later track consumes it.

### Task 0.1: Separate index version domains

**Files:**
- Modify: `src/core/facts/facts.types.ts` (`IndexVersionDomains`)
- Modify: `src/core/repository/index-version.ts` (`CURRENT_INDEX_VERSION_DOMAINS`)
- Modify: `src/config/constants.ts` (new independent `RESOLUTION_VERSION`)
- Test: `test/phase14b-version-domains.test.ts`
- Modify: `test/phase14a-invalidation.test.ts` (add the new required version-domain field to existing planner fixtures)

**Interfaces:**
- Produces `IndexVersionDomains = { schemaVersion, factsSchemaVersion, factsVersion, resolutionVersion, derivedVersion }` with all five values independently supplied.
- Produces `RESOLUTION_VERSION: string`; `GRAPH_INDEX_VERSION` remains the existing graph capability version used by legacy status/compatibility callers.

- [ ] **Step 1: Write the failing test**

```ts
test("version domains expose independent facts schema and resolution versions", () => {
  assert.deepEqual(Object.keys(CURRENT_INDEX_VERSION_DOMAINS).sort(), [
    "derivedVersion", "factsSchemaVersion", "factsVersion", "resolutionVersion", "schemaVersion",
  ]);
  assert.notEqual(CURRENT_INDEX_VERSION_DOMAINS.resolutionVersion, GRAPH_INDEX_VERSION);
  assert.equal(CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion, FACTS_SCHEMA_VERSION);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-version-domains.test.ts`

Expected: FAIL because `factsSchemaVersion` is absent from `IndexVersionDomains` and `resolutionVersion` still aliases `GRAPH_INDEX_VERSION`.

- [ ] **Step 3: Implement the minimal version-domain change**

Add only the independent field and resolution constant. Preserve the current valid facts values in this prerequisite task; the single facts bump is owned by Task 1.3 after the complete facts contract, codec, identity, and cache compatibility exist.

```ts
export type IndexVersionDomains = {
  schemaVersion: string;
  factsSchemaVersion: string;
  factsVersion: string;
  resolutionVersion: string;
  derivedVersion: string;
};

export const RESOLUTION_VERSION = "1.0.0";
export const CURRENT_INDEX_VERSION_DOMAINS: IndexVersionDomains = {
  schemaVersion: ATLAS_SCHEMA_VERSION,
  factsSchemaVersion: FACTS_SCHEMA_VERSION,
  factsVersion: FACTS_VERSION,
  resolutionVersion: RESOLUTION_VERSION,
  derivedVersion: DERIVED_VERSION,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-version-domains.test.ts test/phase14a-invalidation.test.ts`

Expected: PASS; the existing planner fixture compiles after its version object includes `factsSchemaVersion`.

- [ ] **Step 5: Commit**

```bash
git add src/core/facts/facts.types.ts src/core/repository/index-version.ts src/config/constants.ts test/phase14b-version-domains.test.ts test/phase14a-invalidation.test.ts
git commit -m "feat(index): separate Phase 14B version domains"
```

### Task 0.2: Make invalidation reasons and resolution scope explicit

**Files:**
- Modify: `src/core/indexing/invalidation-planner.ts`
- Modify: `src/core/indexing/indexing.types.ts`
- Test: `test/phase14b-invalidation.test.ts`

**Interfaces:**
- Produces `type InvalidationReasonCode = "source_changed" | "direct_importer" | "resolution_version_changed" | "unresolved_import_ownership" | "path_moved" | "path_renamed" | "module_config_changed" | "export_ambiguous" | "dependency_provenance_incomplete" | "facts_version_changed"` and makes `InvalidationPlan.reasons` use that exact union.
- Produces `type ResolutionScopeReason = "changed_source" | "direct_importer" | "resolution_version" | "uncertain_importer" | "module_move" | "module_rename" | "module_config" | "export_ambiguity" | "incomplete_provenance" | "facts_change"`.
- Produces `type ResolutionScope = { mode: "bounded" | "repository"; paths: readonly string[]; reasons: readonly ResolutionScopeReason[] }`.
- Produces `toResolutionScopeReason(reason: InvalidationReasonCode): ResolutionScopeReason` as an exhaustive switch with an `assertNever(value: never): never` branch; no type assertion converts arbitrary planner strings into scope reasons.
- Produces `createResolutionScope(plan: InvalidationPlan): ResolutionScope` with sorted unique paths/reasons.

- [ ] **Step 1: Write the failing test**

```ts
const repositoryCases = [
  ["resolution_version_changed", "resolution_version"],
  ["unresolved_import_ownership", "uncertain_importer"],
  ["path_moved", "module_move"],
  ["path_renamed", "module_rename"],
  ["module_config_changed", "module_config"],
  ["export_ambiguous", "export_ambiguity"],
  ["dependency_provenance_incomplete", "incomplete_provenance"],
  ["facts_version_changed", "facts_change"],
] as const;

test("resolution scope is bounded for a changed file and its direct importer", () => {
  const plan = planInvalidation(fixtureInput({ changed: "src/dep.ts" }));
  assert.deepEqual(createResolutionScope(plan), {
    mode: "bounded",
    paths: ["src/consumer.ts", "src/dep.ts"],
    reasons: ["changed_source", "direct_importer"],
  });
});

test("every unsafe invalidation reason forces repository resolution", () => {
  for (const [planReason, scopeReason] of repositoryCases) {
    const plan = planWithReason(planReason);
    const scope = createResolutionScope(plan);
    assert.equal(scope.mode, "repository", planReason);
    assert.ok(scope.reasons.includes(scopeReason), planReason);
    assert.deepEqual(scope.paths, allResolutionCapablePaths);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-invalidation.test.ts`

Expected: FAIL because the planner reasons are not a closed typed domain and no exhaustive `ResolutionScope` mapping exists.

- [ ] **Step 3: Implement the exhaustive scope contract**

Normalize the planner to `InvalidationReasonCode` at the point each reason is added. Repository-wide causes remain explicit and testable; do not infer safety from a string cast. Keep `parsePaths`, `reusePaths`, `removedPaths`, `resolvePaths`, and `fullGraphResolution` unchanged for existing callers.

```ts
function assertNever(value: never): never {
  throw new Error(`unhandled invalidation reason: ${String(value)}`);
}

export function toResolutionScopeReason(reason: InvalidationReasonCode): ResolutionScopeReason {
  switch (reason) {
    case "source_changed": return "changed_source";
    case "direct_importer": return "direct_importer";
    case "resolution_version_changed": return "resolution_version";
    case "unresolved_import_ownership": return "uncertain_importer";
    case "path_moved": return "module_move";
    case "path_renamed": return "module_rename";
    case "module_config_changed": return "module_config";
    case "export_ambiguous": return "export_ambiguity";
    case "dependency_provenance_incomplete": return "incomplete_provenance";
    case "facts_version_changed": return "facts_change";
    default: return assertNever(reason);
  }
}

export function createResolutionScope(plan: InvalidationPlan): ResolutionScope {
  const reasons = [...new Set(plan.reasons.map(toResolutionScopeReason))].sort();
  const paths = [...new Set(plan.resolvePaths)].sort();
  return { mode: plan.fullGraphResolution ? "repository" : "bounded", paths, reasons };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-invalidation.test.ts test/phase14a-invalidation.test.ts`

Expected: PASS for bounded source/importer cases and every repository-wide cause: resolution-version change, unresolved ownership, move, rename, module config, export ambiguity, incomplete provenance, and broad facts change.

- [ ] **Step 5: Commit**

```bash
git add src/core/indexing/invalidation-planner.ts src/core/indexing/indexing.types.ts test/phase14b-invalidation.test.ts
git commit -m "feat(index): expose safe resolution scopes"
```

### Task 0.3: Make importer provenance objective-facts based

**Files:**
- Modify: `src/core/indexing/invalidation-planner.ts`
- Modify: `src/core/graph/imports.ts`
- Test: `test/phase14b-importer-provenance.test.ts`

**Interfaces:**
- Produces `buildFactReverseImporterIndex(inputs: ReadonlyMap<string, ParsedFactsBlob>): ReadonlyMap<string, ReadonlySet<string>>`.
- Owns `importFactTargets(importerPath: string, fact: ImportFact): readonly string[]`: relative imports return normalized candidate file keys from the existing `resolveImportCandidates`; bare/external specifiers return `module:<specifier>`; unresolved relative candidates are retained as `unresolved:<candidate>` instead of being promoted to resolved ownership.
- The index records relative module targets, `module:<specifier>` targets, and `unresolved:<candidate>` targets from facts; it never requires resolved graph edge IDs.

- [ ] **Step 1: Write the failing test**

```ts
test("fact reverse importer index preserves unresolved and external ownership", () => {
  const reverse = buildFactReverseImporterIndex(new Map([
    ["src/a.ts", factsWithImports("./b.js", "workspace-alias")],
  ]));
  assert.deepEqual([...reverse.entries()].map(([target, importers]) => [target, [...importers]]), [
    ["module:workspace-alias", ["src/a.ts"]],
    ["src/b.js", ["src/a.ts"]],
  ]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-importer-provenance.test.ts`

Expected: FAIL because the current helper accepts legacy `ImportReference` values and the pipeline rebuilds provenance from graph edges.

- [ ] **Step 3: Implement objective-fact provenance**

Normalize each `ImportFact` through `resolveImportCandidates` only for relative imports; retain module and unresolved keys when ownership cannot be proven. Make output sorted and deduplicated. Do not mark an unresolved target as a resolved file. The test-local `factsWithImports(...specifiers: string[])` helper is declared in `test/phase14b-importer-provenance.test.ts`; it returns a complete `ParsedFactsBlob`.

```ts
export function buildFactReverseImporterIndex(
  inputs: ReadonlyMap<string, ParsedFactsBlob>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const reverse = new Map<string, Set<string>>();
  for (const [importer, facts] of [...inputs.entries()].sort(([a], [b]) => a.localeCompare(b))) {
    for (const fact of facts.imports) {
      for (const target of importFactTargets(importer, fact)) {
        const importers = reverse.get(target) ?? new Set<string>();
        importers.add(importer);
        reverse.set(target, importers);
      }
    }
  }
  return new Map([...reverse.entries()].sort(([a], [b]) => a.localeCompare(b)));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-importer-provenance.test.ts test/phase14a-invalidation.test.ts`

Expected: PASS, including deterministic map ordering and uncertain fallback behavior.

- [ ] **Step 5: Commit**

```bash
git add src/core/indexing/invalidation-planner.ts src/core/graph/imports.ts test/phase14b-importer-provenance.test.ts
git commit -m "feat(index): derive importer provenance from facts"
```

### Task 0.4: Lock candidate resolution inputs and unsafe fallback policy

**Files:**
- Create: `src/core/indexing/resolution-scope.ts`
- Modify: `src/core/indexing/indexing.types.ts`
- Test: `test/phase14b-resolution-scope.test.ts`

**Interfaces:**
- Produces `type CandidateResolutionInput = { allUnits: readonly IndexedSourceUnit[]; scope: ResolutionScope; previousGenerationId?: string; previousGraph?: CodeGraph }`.
- Produces `createCandidateResolutionInput(units: readonly IndexedSourceUnit[], scope: ResolutionScope, previousGenerationId: string | undefined, previousGraph: CodeGraph | undefined): CandidateResolutionInput`.
- The contract requires `allUnits` to contain every current resolution-capable file, while `scope.paths` contains only work selected for fresh resolution.

- [ ] **Step 1: Write the failing test**

```ts
test("candidate resolution input retains every unit while selecting a bounded work set", () => {
  const input = createCandidateResolutionInput(units(["a.ts", "b.ts", "c.ts"]), {
    mode: "bounded", paths: ["a.ts", "b.ts"], reasons: ["changed_source"],
  }, "generation-1", graph);
  assert.deepEqual(input.allUnits.map((unit) => unit.relativePath), ["a.ts", "b.ts", "c.ts"]);
  assert.deepEqual(input.scope.paths, ["a.ts", "b.ts"]);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-resolution-scope.test.ts`

Expected: FAIL because the candidate-resolution input type and constructor do not exist.

- [ ] **Step 3: Implement the immutable input contract**

Copy and sort unit references without copying database rows. Reject a scope path that is not present in `allUnits`; for repository mode, normalize `scope.paths` to all unit paths. Keep previous graph optional because a cold generation has no carry-forward source. The test-local `units(...paths: string[])` helper returns `IndexedSourceUnit[]` and `graph` is a `CodeGraph` fixture.

```ts
export function createCandidateResolutionInput(
  units: readonly IndexedSourceUnit[],
  scope: ResolutionScope,
  previousGenerationId: string | undefined,
  previousGraph: CodeGraph | undefined,
): CandidateResolutionInput {
  const allUnits = [...units].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const known = new Set(allUnits.map((unit) => unit.relativePath));
  const paths = scope.mode === "repository" ? allUnits.map((unit) => unit.relativePath) : [...scope.paths].sort();
  if (paths.some((path) => !known.has(path))) throw new Error("resolution scope contains an unknown path");
  return { allUnits, scope: { ...scope, paths }, previousGenerationId, previousGraph };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-resolution-scope.test.ts test/phase14a-invalidation.test.ts`

Expected: PASS, including repository-wide normalization and missing-path rejection.

- [ ] **Step 5: Commit**

```bash
git add src/core/indexing/resolution-scope.ts src/core/indexing/indexing.types.ts test/phase14b-resolution-scope.test.ts
git commit -m "feat(index): define complete candidate resolution inputs"
```

## Track checkpoint

The track is complete when version-domain, importer-provenance, bounded-scope, resolution-version, rename/move, and unsafe-fallback tests pass. No pipeline integration is accepted until the candidate input contract is available to Track 14B-5.
