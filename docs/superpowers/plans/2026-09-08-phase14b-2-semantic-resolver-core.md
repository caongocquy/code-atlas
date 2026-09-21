# Phase 14B-2 Semantic Resolver Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the language-agnostic semantic evidence, deterministic work controls, transient TypeEnvironment, explicit resolution decisions, and an injectable facts-only graph resolver seam.

**Architecture:** Resolver core consumes candidate-generation `ParsedFactsBlob` values normalized by injected language adapters and never reads source text. Task ordering is load-bearing: shared contracts → budgets/memo → TypeEnvironment → decisions/generation context → graph integration. No task references an API introduced by a later task.

**Tech Stack:** TypeScript 7.0.2, Node 22, immutable maps/sets, `node:test`, existing graph node identity and `build-graph.ts`/`build-file-updates.ts` seams.

**Spec:** [Phase14B design](<HOME>/code-atlas/docs/superpowers/specs/2026-09-07-phase14b-multilanguage-resolver-typeenvironment-v2-design.md), §§4, 6–14, 23–24, 29–30, 43.

## Global Constraints

- Resolver outcomes are `resolved`, `ambiguous`, `unknown`, `unsupported`, and `budget_exhausted`.
- Confidence is `exact`, `strong`, or `weak`; weak-only candidates never create authoritative edges.
- Candidate expansion, binding hops, propagation depth, inheritance depth, member candidates, expression nodes, and propagation rounds use deterministic operation budgets.
- Wall-clock time never changes semantics.
- Candidate/evidence/decision/diagnostic arrays are canonically ordered before comparison or persistence.
- `TypeEnvironment` is generation-scoped and transient; it never stores active-generation SQLite row IDs or a persistent semantic cache.
- This track creates no persisted Phase14B edge provenance fields; Track 14B-4 owns categorical edge persistence.
- The new facts-only graph path is injectable and testable before real language adapters exist. The existing production pipeline is switched to the real adapter registry only in Track 14B-5 after Track 14B-3 completes.

### Task 2.1: Define logical identities, evidence, TypeRef, and adapter contracts

**Files:**
- Create: `src/core/graph/resolver/types.ts`
- Create: `src/core/graph/resolver/identities.ts`
- Test: `test/phase14b-resolver-contract.test.ts`

**Interfaces:**
- `type LanguageId = SupportedLanguage` from Track 14B-1.
- `type SourceUnitIdentity = { repositoryId: string; relativePath: string; language: LanguageId }`.
- `type ScopeIdentity = { sourceUnit: SourceUnitIdentity; localId: string; parentLocalId?: string }`.
- `type SymbolIdentity = { repositoryId: string; relativePath: string; language: LanguageId; kind: string; qualifiedName: string; discriminator: string }`.
- `symbolIdentityKey(identity: SymbolIdentity): string` is canonical JSON of those six normalized fields and is the logical rebind key used later by Track 14B-4/5.
- `type ModuleIdentity = { repositoryId: string; normalizedName: string; relativePath?: string }`.
- `type ExpressionIdentity = { sourceUnit: SourceUnitIdentity; localId: string }`.
- `type ResolutionSiteIdentity = { sourceUnit: SourceUnitIdentity; localId: string }`.
- `type EvidenceId = string & { readonly __brand: "EvidenceId" }`.
- `type UnknownReason = "dynamic_expression" | "receiver_type_unknown" | "unresolved_import" | "insufficient_evidence" | "weak_only" | "runtime_dispatch"`.
- `type UnsupportedReason = "language_capability_unsupported" | "compiler_semantics_required" | "framework_semantics_required" | "preprocessor_semantics_required"`.
- `type BudgetReason = "candidate_expansion_limit" | "binding_hop_limit" | "return_depth_limit" | "inheritance_depth_limit" | "member_candidate_limit" | "expression_node_limit" | "propagation_round_limit"`.
- `type AmbiguityReason = "multiple_candidates" | "union_receiver" | "overload_set" | "multiple_implementations"`.
- `type CapabilityLevel = "full" | "partial" | "unsupported" | "not-applicable"` and `type SemanticCapability = "moduleImport" | "localBinding" | "directCall" | "declaredType" | "constructorType" | "receiverMember" | "assignment" | "parameterFlow" | "returnFlow" | "inheritance"`; `SemanticCapabilities = Readonly<Record<SemanticCapability, CapabilityLevel>>`.
- `type TypeRef = { kind: "known"; symbol: SymbolIdentity } | { kind: "named"; name: string; qualification?: readonly string[]; module?: ModuleIdentity } | { kind: "union"; members: readonly TypeRef[] } | { kind: "unknown"; reason: UnknownReason }`.
- The exact evidence record shapes are the Step 3 union. Every record has an `evidenceId`, `sourceUnit`, and objective source range; adapters do not choose targets.
- `type AdapterDiagnostic = { code: string; message: string; sourceUnit: SourceUnitIdentity; range?: SourceRangeFact }`.
- `type SemanticEvidenceBatch` has arrays `bindings`, `imports`, `exports`, `typeAnnotations`, `constructors`, `assignments`, `parameters`, `returns`, `members`, `inheritance`, `implementations`, `aliases`, `modules`, `calls`, plus `diagnostics`.
- `type AdapterContext = { generationId: string; repositoryIdentity: RepositoryIdentity; sourceUnit: SourceUnitIdentity; resolutionVersion: string }`.
- `type LanguageSemanticAdapter = { adapterId: string; adapterVersion: number; languages: readonly LanguageId[]; capabilities(language: LanguageId): SemanticCapabilities; normalizeFile(facts: ParsedFactsBlob, context: AdapterContext): SemanticEvidenceBatch }`.
- `type ResolverTraceEvent = { site: ResolutionSiteIdentity; status: "attempted" | "ambiguous" | "unknown" | "unsupported" | "budget_exhausted"; strategy?: ResolutionStrategyId; reason?: string }` and `type ResolverTraceCollector = { add(event: ResolverTraceEvent): void; snapshot(): readonly ResolverTraceEvent[] }`.
- `type ResolutionStrategyId = "lexical-local" | "imports-exports" | "explicit-type" | "constructor" | "assignment" | "parameter" | "return" | "alias" | "inheritance" | "receiver-member" | "chained-call" | "bounded-interprocedural"`.
- Test-local `symbolIdentity(input: SymbolIdentity): SymbolIdentity` delegates to the production normalizer.

- [ ] **Step 1: Write the failing test**

```ts
test("semantic contracts keep logical identity and uncertainty separate", () => {
  const ref: TypeRef = { kind: "union", members: [
    { kind: "named", name: "AuthService" },
    { kind: "unknown", reason: "dynamic_expression" },
  ] };
  assert.equal(ref.kind, "union");
  const id = symbolIdentity({ repositoryId: "repo", relativePath: "src/auth.ts", language: "typescript", kind: "class", qualifiedName: "AuthService", discriminator: "class:1" });
  assert.equal(symbolIdentityKey(id), symbolIdentityKey({ ...id }));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-resolver-contract.test.ts`

Expected: FAIL because resolver contracts and logical identity constructors do not exist.

- [ ] **Step 3: Implement the exact shared contract**

```ts
type EvidenceBase = { evidenceId: EvidenceId; sourceUnit: SourceUnitIdentity; range: SourceRangeFact };
export type BindingEvidence = EvidenceBase & { kind: "binding"; scope: ScopeIdentity; name: string; bindingId: string; declaredType?: TypeRef };
export type ImportEvidence = EvidenceBase & { kind: "import"; specifier: string; localName?: string; importedName?: string; module?: ModuleIdentity; resolvedPath?: string };
export type ExportEvidence = EvidenceBase & { kind: "export"; exportedName: string; localName?: string; module?: ModuleIdentity };
export type TypeAnnotationEvidence = EvidenceBase & { kind: "type_annotation"; subjectLocalId: string; type: TypeRef };
export type ConstructorEvidence = EvidenceBase & { kind: "constructor"; constructedType: TypeRef; resultBindingId?: string };
export type AssignmentEvidence = EvidenceBase & { kind: "assignment"; targetBindingId: string; sourceExpression?: ExpressionIdentity; sourceType?: TypeRef };
export type ParameterEvidence = EvidenceBase & { kind: "parameter"; callable: SymbolIdentity; index: number; bindingId: string; type?: TypeRef };
export type ReturnEvidence = EvidenceBase & { kind: "return"; callable: SymbolIdentity; expression?: ExpressionIdentity; type?: TypeRef };
export type MemberEvidence = EvidenceBase & { kind: "member"; ownerType: TypeRef; memberName: string; member: SymbolIdentity; access: "instance" | "static" | "extension" };
export type InheritanceEvidence = EvidenceBase & { kind: "inheritance"; subject: SymbolIdentity; target: TypeRef; relation: "extends" | "base" | "trait" | "protocol" | "mixin" };
export type ImplementationEvidence = EvidenceBase & { kind: "implementation"; subject: SymbolIdentity; target: TypeRef; relation: "implements" | "interface" | "trait_impl" | "protocol_conformance" | "extension" | "mixin" };
export type AliasEvidence = EvidenceBase & { kind: "alias"; alias: string; targetName: string; target?: SymbolIdentity | TypeRef };
export type ModuleEvidence = EvidenceBase & { kind: "module"; module: ModuleIdentity; exportedNames: readonly string[] };
export type CallEvidence = EvidenceBase & { kind: "call"; site: ResolutionSiteIdentity; calleeName: string; receiver?: ExpressionIdentity; arguments: readonly ExpressionIdentity[] };

export type SemanticEvidenceBatch = {
  bindings: readonly BindingEvidence[]; imports: readonly ImportEvidence[]; exports: readonly ExportEvidence[];
  typeAnnotations: readonly TypeAnnotationEvidence[]; constructors: readonly ConstructorEvidence[]; assignments: readonly AssignmentEvidence[];
  parameters: readonly ParameterEvidence[]; returns: readonly ReturnEvidence[]; members: readonly MemberEvidence[];
  inheritance: readonly InheritanceEvidence[]; implementations: readonly ImplementationEvidence[]; aliases: readonly AliasEvidence[];
  modules: readonly ModuleEvidence[]; calls: readonly CallEvidence[]; diagnostics: readonly AdapterDiagnostic[];
};

export function symbolIdentity(input: SymbolIdentity): SymbolIdentity {
  return { ...input, relativePath: input.relativePath.replaceAll("\\", "/"), qualifiedName: input.qualifiedName.trim(), discriminator: input.discriminator.trim() };
}

export function symbolIdentityKey(input: SymbolIdentity): string {
  const value = symbolIdentity(input);
  return JSON.stringify([value.repositoryId, value.relativePath, value.language, value.kind, value.qualifiedName, value.discriminator]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-resolver-contract.test.ts`

Expected: PASS for exact evidence batch shape, stable logical identity, type unions, capability levels, and reason unions.

- [ ] **Step 5: Commit**

```bash
git add src/core/graph/resolver/types.ts src/core/graph/resolver/identities.ts test/phase14b-resolver-contract.test.ts
git commit -m "feat(graph): define Phase 14B semantic contracts"
```

### Task 2.2: Add deterministic budgets and stable memoization

**Files:**
- Create: `src/core/graph/resolver/budgets.ts`
- Create: `src/core/graph/resolver/memo.ts`
- Test: `test/phase14b-resolver-work-controls.test.ts`

**Interfaces:**
- `type ResolverBudgets = { candidateExpansions: number; bindingHops: number; returnDepth: number; inheritanceDepth: number; memberCandidates: number; expressionNodes: number; propagationRounds: number }`.
- `type BudgetKind = keyof ResolverBudgets`.
- `type BudgetLedger = { consume(kind: BudgetKind, amount?: number): boolean; remaining(kind: BudgetKind): number; snapshot(): Readonly<ResolverBudgets> }`.
- `createBudgetLedger(budgets: ResolverBudgets): BudgetLedger` consumes deterministic operation units only.
- `type MemoEntry = { kind: "types"; values: readonly TypeRef[]; evidenceIds: readonly EvidenceId[] } | { kind: "symbols"; values: readonly SymbolIdentity[]; evidenceIds: readonly EvidenceId[] } | { kind: "unknown"; reason: UnknownReason; evidenceIds: readonly EvidenceId[]; stable: true }`.
- `type ResolverMemo = { get(key: string): MemoEntry | undefined; set(key: string, value: MemoEntry): void; size(): number }` and `createResolverMemo(): ResolverMemo`.
- Budget exhaustion, infrastructure failure, degraded parser state, and unstable/incomplete negative results have no `MemoEntry` representation and therefore cannot become authoritative cached truth.

- [ ] **Step 1: Write the failing test**

```ts
test("budget ledger is deterministic and memo stores only stable entries", () => {
  const ledger = createBudgetLedger({ candidateExpansions: 2, bindingHops: 1, returnDepth: 1, inheritanceDepth: 1, memberCandidates: 1, expressionNodes: 2, propagationRounds: 1 });
  assert.equal(ledger.consume("candidateExpansions"), true);
  assert.equal(ledger.consume("candidateExpansions"), true);
  assert.equal(ledger.consume("candidateExpansions"), false);
  const memo = createResolverMemo();
  memo.set("k", { kind: "unknown", reason: "dynamic_expression", evidenceIds: [], stable: true });
  assert.equal(memo.get("k")?.kind, "unknown");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-resolver-work-controls.test.ts`

Expected: FAIL because deterministic budget and memo contracts do not exist.

- [ ] **Step 3: Implement deterministic work controls**

```ts
export function createBudgetLedger(budgets: ResolverBudgets): BudgetLedger {
  const state: ResolverBudgets = { ...budgets };
  return {
    consume(kind, amount = 1) {
      if (amount < 0 || state[kind] < amount) return false;
      state[kind] -= amount;
      return true;
    },
    remaining: (kind) => state[kind],
    snapshot: () => ({ ...state }),
  };
}

export function createResolverMemo(): ResolverMemo {
  const values = new Map<string, MemoEntry>();
  return { get: (key) => values.get(key), set: (key, value) => { values.set(key, value); }, size: () => values.size };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-resolver-work-controls.test.ts`

Expected: PASS at exact budget boundaries and for stable memo entries without timeout-based behavior.

- [ ] **Step 5: Commit**

```bash
git add src/core/graph/resolver/budgets.ts src/core/graph/resolver/memo.ts test/phase14b-resolver-work-controls.test.ts
git commit -m "feat(graph): add deterministic resolver work controls"
```

### Task 2.3: Implement generation-scoped TypeEnvironment

**Files:**
- Create: `src/core/graph/resolver/type-environment.ts`
- Test: `test/phase14b-type-environment.test.ts`

**Interfaces:**
- `type LookupResult<T> = { status: "found"; values: readonly T[]; evidenceIds: readonly EvidenceId[] } | { status: "unknown"; reason: UnknownReason; evidenceIds: readonly EvidenceId[] } | { status: "unsupported"; reason: UnsupportedReason; evidenceIds: readonly EvidenceId[] } | { status: "budget_exhausted"; reason: BudgetReason; evidenceIds: readonly EvidenceId[] }`.
- `type TypeEnvironmentInput = { generationId: string; symbols: readonly SymbolIdentity[]; evidence: readonly SemanticEvidenceBatch[]; budget: BudgetLedger; memo: ResolverMemo }`.
- `type TypeEnvironment = { lookupBinding(scope: ScopeIdentity, name: string): LookupResult<BindingEvidence>; inferType(expression: ExpressionIdentity): LookupResult<TypeRef>; resolveMember(receiverType: TypeRef, member: string): LookupResult<SymbolIdentity>; resolveReturn(callable: SymbolIdentity): LookupResult<TypeRef>; resolveInheritance(type: TypeRef): LookupResult<TypeRef>; resolveImport(module: ModuleIdentity): LookupResult<SymbolIdentity> }`.
- Owns these internal helpers with exact signatures: `indexBindings(evidence: readonly SemanticEvidenceBatch[]): ReadonlyMap<string, readonly BindingEvidence[]>`; `lookupInnermost(index: ReadonlyMap<string, readonly BindingEvidence[]>, scope: ScopeIdentity, name: string, budget: BudgetLedger): LookupResult<BindingEvidence>`; `inferFromEvidence(evidence: readonly SemanticEvidenceBatch[], expression: ExpressionIdentity, budget: BudgetLedger, memo: ResolverMemo): LookupResult<TypeRef>`; `lookupMembers(evidence: readonly SemanticEvidenceBatch[], owner: TypeRef, member: string, budget: BudgetLedger): LookupResult<SymbolIdentity>`; `lookupReturns(evidence: readonly SemanticEvidenceBatch[], callable: SymbolIdentity, budget: BudgetLedger): LookupResult<TypeRef>`; `lookupInheritance(evidence: readonly SemanticEvidenceBatch[], type: TypeRef, budget: BudgetLedger): LookupResult<TypeRef>`; `lookupImports(evidence: readonly SemanticEvidenceBatch[], module: ModuleIdentity, budget: BudgetLedger): LookupResult<SymbolIdentity>`.
- Test-local `environmentInput(options?: { shadowedBindings?: boolean; memberCandidates?: number }): TypeEnvironmentInput` and `scope(name: string): ScopeIdentity` are declared in the test.

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

Expected: FAIL because `createTypeEnvironment` and its bounded lookups do not exist.

- [ ] **Step 3: Implement bounded environment construction**

```ts
export function createTypeEnvironment(input: TypeEnvironmentInput): TypeEnvironment {
  const bindings = indexBindings(input.evidence);
  return {
    lookupBinding: (scopeId, name) => lookupInnermost(bindings, scopeId, name, input.budget),
    inferType: (expression) => inferFromEvidence(input.evidence, expression, input.budget, input.memo),
    resolveMember: (owner, member) => lookupMembers(input.evidence, owner, member, input.budget),
    resolveReturn: (callable) => lookupReturns(input.evidence, callable, input.budget),
    resolveInheritance: (type) => lookupInheritance(input.evidence, type, input.budget),
    resolveImport: (module) => lookupImports(input.evidence, module, input.budget),
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-type-environment.test.ts test/phase14b-resolver-work-controls.test.ts`

Expected: PASS for shadowing, multi-candidate lookup, unknown type, unsupported construct, and deterministic budget-exhaustion cases.

- [ ] **Step 5: Commit**

```bash
git add src/core/graph/resolver/type-environment.ts test/phase14b-type-environment.test.ts
git commit -m "feat(graph): add bounded TypeEnvironment"
```

### Task 2.4: Implement decisions, strategies, generation context, and determinism

**Files:**
- Create: `src/core/graph/resolver/decision.ts`
- Create: `src/core/graph/resolver/strategies.ts`
- Create: `src/core/graph/resolver/resolver.ts`
- Create: `src/core/graph/resolver/generation-context.ts`
- Test: `test/phase14b-resolver-decisions.test.ts`
- Test: `test/phase14b-resolver-determinism.test.ts`

**Interfaces:**
- `type ResolvableEdgeKind = "calls" | "references" | "extends" | "implements"`.
- `type ResolutionDecisionBase = { site: ResolutionSiteIdentity; language: LanguageId; sourceUnit: SourceUnitIdentity; edgeKind: ResolvableEdgeKind; evidenceIds: readonly EvidenceId[]; attemptedStrategies: readonly ResolutionStrategyId[]; resolutionVersion: string }`.
- `type ResolutionDecision = ResolutionDecisionBase & ({ status: "resolved"; target: SymbolIdentity; strategy: ResolutionStrategyId; confidence: "exact" | "strong" } | { status: "ambiguous"; candidates: readonly SymbolIdentity[]; reason: AmbiguityReason } | { status: "unknown"; reason: UnknownReason } | { status: "unsupported"; reason: UnsupportedReason } | { status: "budget_exhausted"; reason: BudgetReason })`.
- `type ResolutionCandidate = { target: SymbolIdentity; strategy: ResolutionStrategyId; confidence: "exact" | "strong" | "weak"; evidenceIds: readonly EvidenceId[] }`.
- `type ResolverInput = { facts: ParsedFactsBlob; evidence: SemanticEvidenceBatch; environment: TypeEnvironment; context: GenerationResolverContext }`.
- `type GenerationResolverContext = { generationId: string; repositoryIdentity: RepositoryIdentity; parsedFactsView: readonly ParsedFactsBlob[]; languageRegistry: readonly LanguageSemanticAdapter[]; typeEnvironment: TypeEnvironment; budget: BudgetLedger; memo: ResolverMemo; diagnostics: ResolverTraceCollector; resolutionVersion: string }`.
- `createGenerationResolverContext(input: Omit<GenerationResolverContext, "diagnostics"> & { diagnostics?: ResolverTraceCollector }): GenerationResolverContext` supplies an in-memory collector when omitted.
- `resolveStrategy(input: ResolverInput, site: ResolutionSiteIdentity, strategy: ResolutionStrategyId): readonly ResolutionCandidate[]` owns each strategy dispatch and returns canonically sorted candidates.
- `uniqueTargetGate(input: ResolverInput, site: ResolutionSiteIdentity, candidates: readonly ResolutionCandidate[], attemptedStrategies: readonly ResolutionStrategyId[]): ResolutionDecision` implements exact/strong/weak/ambiguous/budget rules.
- `resolveSite(input: ResolverInput, site: ResolutionSiteIdentity): ResolutionDecision` runs `ORDERED_STRATEGIES` exactly once in fixed order.
- Test-local `candidate`, `decisionFor`, `tinyBudgets`, `resolveFixture`, and `normalizeDecision` signatures are declared in their owning tests.

- [ ] **Step 1: Write the failing tests**

```ts
test("unique gate accepts strong single target and drops weak or ambiguous candidates", () => {
  assert.equal(decisionFor([candidate("target", "strong")]).status, "resolved");
  assert.equal(decisionFor([candidate("a", "strong"), candidate("b", "strong")]).status, "ambiguous");
  assert.equal(decisionFor([candidate("target", "weak")]).status, "unknown");
});

test("budget exhaustion and warm memoization preserve deterministic semantics", () => {
  const cold = resolveFixture({ memo: createResolverMemo(), budgets: tinyBudgets() });
  const warmMemo = createResolverMemo();
  const warmFirst = resolveFixture({ memo: warmMemo, budgets: tinyBudgets() });
  const warmSecond = resolveFixture({ memo: warmMemo, budgets: tinyBudgets() });
  assert.equal(cold.decision.status, "budget_exhausted");
  assert.deepEqual(normalizeDecision(warmFirst.decision), normalizeDecision(warmSecond.decision));
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx/esm --test test/phase14b-resolver-decisions.test.ts test/phase14b-resolver-determinism.test.ts`

Expected: FAIL because terminal decisions, ordered strategies, generation context, and resolver determinism do not exist.

- [ ] **Step 3: Implement ordered resolution and generation context**

```ts
export const ORDERED_STRATEGIES: readonly ResolutionStrategyId[] = [
  "lexical-local", "imports-exports", "explicit-type", "constructor", "assignment", "parameter",
  "return", "alias", "inheritance", "receiver-member", "chained-call", "bounded-interprocedural",
];

export function resolveSite(input: ResolverInput, site: ResolutionSiteIdentity): ResolutionDecision {
  const attempted: ResolutionStrategyId[] = [];
  const candidates: ResolutionCandidate[] = [];
  for (const strategy of ORDERED_STRATEGIES) {
    attempted.push(strategy);
    candidates.push(...resolveStrategy(input, site, strategy));
  }
  return uniqueTargetGate(input, site, candidates, attempted);
}

export function createGenerationResolverContext(
  input: Omit<GenerationResolverContext, "diagnostics"> & { diagnostics?: ResolverTraceCollector },
): GenerationResolverContext {
  const events: ResolverTraceEvent[] = [];
  return {
    ...input,
    diagnostics: input.diagnostics ?? { add: (event) => { events.push(event); }, snapshot: () => [...events] },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx/esm --test test/phase14b-resolver-decisions.test.ts test/phase14b-resolver-determinism.test.ts test/phase14b-type-environment.test.ts`

Expected: PASS for all five terminal decisions, weak rejection, ambiguity preservation, fixed strategy order, deterministic operation budgets, and cold/warm memo semantic equivalence.

- [ ] **Step 5: Commit**

```bash
git add src/core/graph/resolver/decision.ts src/core/graph/resolver/strategies.ts src/core/graph/resolver/resolver.ts src/core/graph/resolver/generation-context.ts test/phase14b-resolver-decisions.test.ts test/phase14b-resolver-determinism.test.ts
git commit -m "feat(graph): add deterministic semantic resolution"
```

### Task 2.5: Add the injectable facts-only graph resolver path

**Files:**
- Modify: `src/core/graph/build-graph.ts`
- Modify: `src/core/graph/build-file-updates.ts`
- Modify: `src/core/graph/call-resolution.ts`
- Modify: `src/core/graph/member-resolution.ts`
- Modify: `src/core/graph/extends.ts`
- Test: `test/phase14b-facts-graph-resolver.test.ts`
- Test: `test/phase14b-no-source-side-channel.test.ts`
- Modify: `test/graph.test.ts` (preserve legacy production path until Track 14B-5 switches orchestration)

**Interfaces:**
- `type GraphResolutionFile = { relativePath: string; decisions: readonly ResolutionDecision[]; trace: readonly ResolverTraceEvent[] }`.
- Produces `normalizeFacts(facts: readonly ParsedFactsBlob[], context: GenerationResolverContext): readonly SemanticEvidenceBatch[]`; it finds the adapter only from `context.languageRegistry`, and missing adapters generate explicit unsupported trace rather than source fallback.
- Produces `resolveIndexedUnits(input: { allUnits: readonly IndexedSourceUnit[]; resolvePaths: ReadonlySet<string>; evidence: readonly SemanticEvidenceBatch[]; context: GenerationResolverContext }): Map<string, GraphResolutionFile>`.
- Owns `assembleFactsGraph(repoPath: string, units: readonly IndexedSourceUnit[], resolutionByFile: ReadonlyMap<string, GraphResolutionFile>, reporter?: ProgressReporter, repositoryId?: string): GraphBuildResult`; it assembles structural nodes/imports/contains plus accepted resolver decisions using candidate in-memory graph node IDs only.
- Produces `buildCodeGraphWithResolutionFromFacts(repoPath: string, units: readonly IndexedSourceUnit[], reporter: ProgressReporter | undefined, repositoryId: string | undefined, resolutionPaths: readonly string[] | undefined, context: GenerationResolverContext): Promise<GraphBuildResult & { resolutionByFile: Map<string, GraphResolutionFile> }>`.
- The new facts path consumes no source text. Existing legacy graph construction may remain available for existing callers until Track 14B-5 switches the pipeline after real adapters are registered.
- Test-local `buildFactsGraphFixture(input: string | { source: string; resolutionPaths?: readonly string[] }): Promise<GraphBuildResult & { resolutionByFile: Map<string, GraphResolutionFile>; semanticSourceFallbackCalls: number }>` creates a test adapter/context from Task 2.1 contracts; it does not depend on Track 14B-3.

- [ ] **Step 1: Write the failing tests**

```ts
test("facts graph accepts only the strong semantic decision returned by the resolver", async () => {
  const result = await buildFactsGraphFixture({ source: serviceFixtureSource(), resolutionPaths: ["consumer.ts"] });
  const decision = result.resolutionByFile.get("consumer.ts")?.decisions.find((item) => item.status === "resolved");
  assert.equal(decision?.status, "resolved");
  if (decision?.status === "resolved") assert.equal(decision.confidence, "strong");
  assert.equal(result.graph.edges.filter((edge) => edge.type === "calls").length, 1);
});

test("facts graph construction does not invoke semantic source-text fallback", async () => {
  const result = await buildFactsGraphFixture("export class Service { refresh() {} }\nexport function run(service: Service) { service.refresh(); }\n");
  assert.equal(result.semanticSourceFallbackCalls, 0);
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `node --import tsx/esm --test test/phase14b-facts-graph-resolver.test.ts test/phase14b-no-source-side-channel.test.ts`

Expected: FAIL because the new injected facts-only resolver path and `resolutionByFile` decision output do not exist.

- [ ] **Step 3: Implement the injected facts-only integration seam**

```ts
export async function buildCodeGraphWithResolutionFromFacts(
  repoPath: string,
  units: readonly IndexedSourceUnit[],
  reporter: ProgressReporter | undefined,
  repositoryId: string | undefined,
  resolutionPaths: readonly string[] | undefined,
  context: GenerationResolverContext,
): Promise<GraphBuildResult & { resolutionByFile: Map<string, GraphResolutionFile> }> {
  const evidence = normalizeFacts(units.map((unit) => unit.facts), context);
  const resolutionByFile = resolveIndexedUnits({
    allUnits: units,
    resolvePaths: new Set(resolutionPaths ?? units.map((unit) => unit.relativePath)),
    evidence,
    context,
  });
  const graph = assembleFactsGraph(repoPath, units, resolutionByFile, reporter, repositoryId);
  return { ...graph, resolutionByFile };
}
```

The implementation of `normalizeFacts` must match adapters by `facts.language` against `context.languageRegistry`; the implementation of `resolveIndexedUnits` builds no source-derived bindings. Remove source/regex semantic helpers from this **facts path only**. Do not persist `GraphEdge.resolution` yet; Track 14B-4 owns that storage-facing contract.

- [ ] **Step 4: Run tests to verify they pass**

Run: `node --import tsx/esm --test test/phase14b-facts-graph-resolver.test.ts test/phase14b-no-source-side-channel.test.ts test/graph.test.ts`

Expected: PASS for injected semantic decisions, accepted logical edges, no facts-path source fallback, and unchanged legacy graph behavior for callers not yet switched to the new path.

- [ ] **Step 5: Commit**

```bash
git add src/core/graph/build-graph.ts src/core/graph/build-file-updates.ts src/core/graph/call-resolution.ts src/core/graph/member-resolution.ts src/core/graph/extends.ts test/phase14b-facts-graph-resolver.test.ts test/phase14b-no-source-side-channel.test.ts test/graph.test.ts
git commit -m "feat(graph): add injected facts-only semantic resolver"
```

## Track checkpoint

Track 14B-2 is complete when shared contracts exist before all consumers, budgets/memo precede TypeEnvironment, TypeEnvironment precedes decisions/context, and the injected facts path produces explicit decisions without source semantic fallback or persisted Phase14B provenance. Track 14B-3 may now implement concrete adapters against these exact contracts.
