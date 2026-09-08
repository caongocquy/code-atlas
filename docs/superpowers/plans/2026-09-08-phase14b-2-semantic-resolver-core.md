# Phase 14B-2 Semantic Resolver Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the language-agnostic evidence, TypeEnvironment, decision, strategy, budget, memoization, and facts-graph resolver core.

**Architecture:** Resolver core consumes candidate-generation facts normalized by language adapters and never sees source text. A transient `TypeEnvironment` answers uncertainty-preserving lookups; ordered strategies produce one `ResolutionDecision`, then the unique-target gate either accepts one exact/strong target or emits an explicit non-edge outcome.

**Tech Stack:** TypeScript 7.0.2, Node 22, immutable maps/sets, `node:test`, existing graph node identity and `build-graph.ts`/`build-file-updates.ts` seams.

**Spec:** [Phase14B revised design](<HOME>/code-atlas/docs/superpowers/specs/2026-09-07-phase14b-multilanguage-resolver-typeenvironment-v2-design-revised.md), §§4, 6–14, 23–24, 29–30, 43.

## Global Constraints

- Resolver outcomes are `resolved`, `ambiguous`, `unknown`, `unsupported`, and `budget_exhausted`.
- Confidence is `exact`, `strong`, or `weak`; weak-only candidates never create edges.
- Candidate expansion, binding hops, propagation depth, inheritance depth, member candidates, expression nodes, and propagation rounds use deterministic operation budgets.
- Wall-clock time never changes semantics.
- Candidate/evidence/decision/diagnostic arrays are canonically ordered before comparison or persistence.
- `TypeEnvironment` is generation-scoped and transient; it never stores active-generation row IDs or a persistent semantic cache.
- This track owns the facts graph resolver path, not storage migrations or language grammar modules.

### Task 2.1: Define logical identities, evidence, TypeRef, and adapter contracts

**Files:**
- Create: `src/core/graph/resolver/types.ts`
- Create: `src/core/graph/resolver/identities.ts`
- Test: `test/phase14b-resolver-contract.test.ts`

**Interfaces:**
- `type LanguageId = SupportedLanguage` from the expanded parser type.
- `type SymbolIdentity = { repositoryId: string; relativePath: string; language: LanguageId; kind: string; qualifiedName: string; discriminator: string }`.
- `type ModuleIdentity = { repositoryId: string; normalizedName: string; relativePath?: string }`.
- `type ExpressionIdentity = { sourceUnit: string; localId: string }`.
- `type EvidenceId = string & { readonly __brand: "EvidenceId" }`.
- `type TypeRef = { kind: "known"; symbol: SymbolIdentity } | { kind: "named"; name: string; qualification?: readonly string[]; module?: ModuleIdentity } | { kind: "union"; members: readonly TypeRef[] } | { kind: "unknown"; reason: UnknownReason }`.
- `type SemanticEvidenceBatch` contains the fourteen required arrays and `diagnostics` from the spec.
- `type LanguageSemanticAdapter = { adapterId: string; adapterVersion: number; languages: readonly LanguageId[]; capabilities(language: LanguageId): SemanticCapabilities; normalizeFile(facts: ParsedFactsBlob, context: AdapterContext): SemanticEvidenceBatch }`.
- `type AdapterContext = { generationId: string; repositoryIdentity: RepositoryIdentity; sourceUnit: SourceUnitIdentity; resolutionVersion: string }`.

- [ ] **Step 1: Write the failing test**

```ts
test("semantic contracts keep logical identity and uncertainty separate", () => {
  const ref: TypeRef = { kind: "union", members: [
    { kind: "named", name: "AuthService" },
    { kind: "unknown", reason: "dynamic_expression" },
  ] };
  assert.equal(ref.kind, "union");
  const id = symbolIdentity({ repositoryId: "repo", relativePath: "src/auth.ts", language: "typescript", kind: "class", qualifiedName: "AuthService", discriminator: "class:1" });
  assert.equal(id.relativePath, "src/auth.ts");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-resolver-contract.test.ts`

Expected: FAIL because resolver contracts and logical identity constructors do not exist.

- [ ] **Step 3: Implement the shared contract**

Define explicit reason unions, evidence records, capabilities, source-unit identity, and deterministic identity constructors. Normalize unions by stable JSON ordering and keep all types free of graph target decisions.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-resolver-contract.test.ts`

Expected: PASS with stable identity and union normalization assertions.

- [ ] **Step 5: Commit**

```bash
git add src/core/graph/resolver/types.ts src/core/graph/resolver/identities.ts test/phase14b-resolver-contract.test.ts
git commit -m "feat(graph): define Phase 14B semantic contracts"
```

### Task 2.2: Implement generation-scoped TypeEnvironment

**Files:**
- Create: `src/core/graph/resolver/type-environment.ts`
- Test: `test/phase14b-type-environment.test.ts`

**Interfaces:**
- `type LookupResult<T> = { status: "found"; values: readonly T[]; evidenceIds: readonly EvidenceId[] } | { status: "unknown"; reason: UnknownReason; evidenceIds: readonly EvidenceId[] } | { status: "unsupported"; reason: UnsupportedReason; evidenceIds: readonly EvidenceId[] } | { status: "budget_exhausted"; reason: BudgetReason; evidenceIds: readonly EvidenceId[] }`.
- `type TypeEnvironmentInput = { generationId: string; symbols: readonly SymbolIdentity[]; evidence: readonly SemanticEvidenceBatch[]; budgets: ResolverBudgets; memo: ResolverMemo }`.
- `createTypeEnvironment(input: TypeEnvironmentInput): TypeEnvironment` implements `lookupBinding`, `inferType`, `resolveMember`, `resolveReturn`, `resolveInheritance`, and `resolveImport`.

- [ ] **Step 1: Write the failing test**

```ts
test("environment preserves shadowing and multiple member candidates", () => {
  const environment = createTypeEnvironment(environmentInput({ shadowedBindings: true, memberCandidates: 2 }));
  assert.equal(environment.lookupBinding(scope("run"), "service").status, "found");
  const member = environment.resolveMember({ kind: "named", name: "Service" }, "refresh");
  assert.equal(member.status, "found");
  if (member.status === "found") assert.equal(member.values.length, 2);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-type-environment.test.ts`

Expected: FAIL because `createTypeEnvironment` and `TypeEnvironment` do not exist.

- [ ] **Step 3: Implement bounded environment construction**

Index evidence by scope, binding name, expression, member owner, callable return, import identity, inheritance relation, and alias. Resolve innermost lexical binding first, preserve all candidate values, attach evidence IDs, and return explicit unknown/unsupported/budget results without selecting a target.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-type-environment.test.ts`

Expected: PASS for shadowing, multi-candidate lookup, unknown type, unsupported construct, and budget-exhaustion cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/graph/resolver/type-environment.ts test/phase14b-type-environment.test.ts
git commit -m "feat(graph): add bounded TypeEnvironment"
```

### Task 2.3: Implement decisions, unique-target gate, and ordered strategies

**Files:**
- Create: `src/core/graph/resolver/decision.ts`
- Create: `src/core/graph/resolver/strategies.ts`
- Create: `src/core/graph/resolver/resolver.ts`
- Test: `test/phase14b-resolver-decisions.test.ts`

**Interfaces:**
- `type ResolutionDecisionBase = { site: ResolutionSiteIdentity; language: LanguageId; sourceUnit: SourceUnitIdentity; edgeKind: ResolvableEdgeKind; evidenceIds: readonly EvidenceId[]; attemptedStrategies: readonly ResolutionStrategyId[]; resolutionVersion: string }`.
- `type ResolutionDecision = ResolutionDecisionBase & ({ status: "resolved"; target: SymbolIdentity; strategy: ResolutionStrategyId; confidence: "exact" | "strong" } | { status: "ambiguous"; candidates: readonly SymbolIdentity[]; reason: AmbiguityReason } | { status: "unknown"; reason: UnknownReason } | { status: "unsupported"; reason: UnsupportedReason } | { status: "budget_exhausted"; reason: BudgetReason })`.
- `type ResolverInput = { facts: ParsedFactsBlob; evidence: SemanticEvidenceBatch; environment: TypeEnvironment; context: GenerationResolverContext }`.
- `resolveSite(input: ResolverInput, site: ResolutionSiteIdentity): ResolutionDecision` runs strategies in this fixed order: lexical/local, imports/exports, explicit type, constructor, assignments, parameters, returns, aliases, inheritance/interfaces/traits, receiver/member, chained, bounded interprocedural.

- [ ] **Step 1: Write the failing test**

```ts
test("unique gate accepts strong single target and drops weak or ambiguous candidates", () => {
  assert.equal(decisionFor([candidate("target", "strong")]).status, "resolved");
  assert.equal(decisionFor([candidate("a", "strong"), candidate("b", "strong")]).status, "ambiguous");
  assert.equal(decisionFor([candidate("target", "weak")]).status, "unknown");
  assert.equal(decisionFor([], { unsupported: true }).status, "unsupported");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-resolver-decisions.test.ts`

Expected: FAIL because the new decision categories and unique-target gate do not exist.

- [ ] **Step 3: Implement ordered resolution**

Run each strategy against the environment, retain all structurally plausible candidates, reject weak-only results, and emit the exact terminal category. Never rank by name or choose the first candidate. Record every attempted strategy in deterministic order.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-resolver-decisions.test.ts test/phase14b-type-environment.test.ts`

Expected: PASS for all five terminal decisions, weak rejection, exact/strong acceptance, ambiguity preservation, and stable strategy order.

- [ ] **Step 5: Commit**

```bash
git add src/core/graph/resolver/decision.ts src/core/graph/resolver/strategies.ts src/core/graph/resolver/resolver.ts test/phase14b-resolver-decisions.test.ts
git commit -m "feat(graph): add conservative resolution decisions"
```

### Task 2.4: Add deterministic budgets, memoization, and generation context

**Files:**
- Create: `src/core/graph/resolver/budgets.ts`
- Create: `src/core/graph/resolver/memo.ts`
- Create: `src/core/graph/resolver/generation-context.ts`
- Test: `test/phase14b-resolver-determinism.test.ts`

**Interfaces:**
- `type ResolverBudgets = { candidateExpansions: number; bindingHops: number; returnDepth: number; inheritanceDepth: number; memberCandidates: number; expressionNodes: number; propagationRounds: number }`.
- `createBudgetLedger(budgets: ResolverBudgets): BudgetLedger` exposes `consume(kind: BudgetKind, amount?: number): boolean` and `remaining(kind: BudgetKind): number`.
- `createResolverMemo(): ResolverMemo` exposes `get(key: string): MemoEntry | undefined` and `set(key: string, value: MemoEntry): void`.
- `type GenerationResolverContext = { generationId: string; repositoryIdentity: RepositoryIdentity; parsedFactsView: readonly ParsedFactsBlob[]; languageRegistry: readonly LanguageSemanticAdapter[]; typeEnvironment: TypeEnvironment; budgets: BudgetLedger; memo: ResolverMemo; diagnostics: DiagnosticsCollector; resolutionVersion: string }`.

- [ ] **Step 1: Write the failing test**

```ts
test("budget exhaustion is reproducible and warm memoization preserves semantics", () => {
  const cold = resolveFixture({ memo: createResolverMemo(), budgets: tinyBudgets() });
  const warmMemo = createResolverMemo();
  const warmFirst = resolveFixture({ memo: warmMemo, budgets: tinyBudgets() });
  const warmSecond = resolveFixture({ memo: warmMemo, budgets: tinyBudgets() });
  assert.equal(cold.decision.status, "budget_exhausted");
  assert.deepEqual(normalizeDecision(warmFirst.decision), normalizeDecision(warmSecond.decision));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-resolver-determinism.test.ts`

Expected: FAIL because budgets, memoization, and generation context are not implemented.

- [ ] **Step 3: Implement deterministic work accounting**

Consume only semantic operation units; sort candidates before consuming; memoize by candidate generation, resolution version, language, expression/member identity, and strategy input. Return budget exhaustion without a fallback target. Exclude memo hit/miss counts from semantic equivalence comparison.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-resolver-determinism.test.ts`

Expected: PASS for cold/warm memo semantic equivalence, budget boundary, counter accounting, and no wall-clock dependency.

- [ ] **Step 5: Commit**

```bash
git add src/core/graph/resolver/budgets.ts src/core/graph/resolver/memo.ts src/core/graph/resolver/generation-context.ts test/phase14b-resolver-determinism.test.ts
git commit -m "feat(graph): bound and memoize semantic resolution"
```

### Task 2.5: Replace facts-graph legacy resolution with the shared resolver

**Files:**
- Modify: `src/core/graph/build-graph.ts`
- Modify: `src/core/graph/build-file-updates.ts`
- Modify: `src/core/graph/call-resolution.ts`
- Modify: `src/core/graph/member-resolution.ts`
- Modify: `src/core/graph/extends.ts`
- Test: `test/phase14b-facts-graph-resolver.test.ts`
- Test: `test/phase14b-no-source-side-channel.test.ts`

**Interfaces:**
- Produces `buildCodeGraphWithResolutionFromFacts(repoPath: string, units: readonly IndexedSourceUnit[], reporter?: ProgressReporter, repositoryId?: string, resolutionPaths?: readonly string[], context?: GenerationResolverContext): Promise<GraphBuildResult>`.
- Produces `buildFileGraphsFromFacts(repoPath: string, units: readonly IndexedSourceUnit[], impactedFiles: readonly string[], repositoryId: string, context: GenerationResolverContext): Promise<GraphFileUpdateResult>` or the repository-native equivalent with the same inputs and outputs.
- Facts-path resolver functions consume `ParsedFactsBlob` and `SemanticEvidenceBatch`; they do not receive source text.

- [ ] **Step 1: Write the failing test**

```ts
test("facts graph emits only accepted semantic edges with Phase 14B decisions", async () => {
  const result = await buildFactsGraphFixture({ source: serviceFixtureSource(), resolutionPaths: ["consumer.ts"] });
  const calls = result.graph.edges.filter((edge) => edge.type === "calls");
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.resolution?.confidence, "strong");
  assert.equal(result.resolutionByFile.get("consumer.ts")?.diagnostics.some((item) => item.status === "unknown"), false);
});

test("facts graph construction does not invoke semantic source-text fallback", async () => {
  const result = await buildFactsGraphFixture("export class Service { refresh() {} }\nexport function run(service: Service) { service.refresh(); }\n");
  assert.equal(result.semanticSourceFallbackCalls, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-facts-graph-resolver.test.ts`

Expected: FAIL because the facts path still calls legacy resolver functions with source text and persists numeric-confidence edges.

- [ ] **Step 3: Implement facts-only resolver integration**

Normalize every unit through the registered language adapter, build one environment for the candidate generation, resolve only the requested paths, and assemble accepted edges by logical identity. Keep all units available for node/import/contains graph completeness. Delete the facts-path calls to `extractFactsObjectBindings`, `extractFactsParameterBindings`, `extractFactsClassFieldBindings`, and `extractExtendsFactEvidence`; leave source parsing isolated to the explicit legacy graph path.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-facts-graph-resolver.test.ts test/phase14b-no-source-side-channel.test.ts test/phase14a-equivalence.test.ts test/graph.test.ts`

Expected: PASS for accepted provenance, ambiguity/unknown drop, member/extends facts, clean graph equivalence, and legacy graph regressions.

- [ ] **Step 5: Commit**

```bash
git add src/core/graph/build-graph.ts src/core/graph/build-file-updates.ts src/core/graph/call-resolution.ts src/core/graph/member-resolution.ts src/core/graph/extends.ts test/phase14b-facts-graph-resolver.test.ts test/phase14a-equivalence.test.ts test/graph.test.ts
git commit -m "feat(graph): route facts through semantic resolver"
```

## Track checkpoint

Track 14B-2 is complete when the shared contracts, transient environment, five decision categories, unique gate, deterministic budgets/memo, and facts-only graph path pass focused tests without source semantic fallback. Language adapters may now implement the exact contracts.
