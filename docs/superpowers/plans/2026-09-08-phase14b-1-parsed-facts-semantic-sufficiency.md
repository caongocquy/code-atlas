# Phase 14B-1 ParsedFacts Semantic Sufficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the persisted objective fact contract so every Phase14B adapter can resolve its declared semantic floor without reparsing source text.

**Architecture:** Preserve path-neutral immutable fact blobs and generation-scoped file bindings. Replace the current JS/TS-only extractor dispatch with a language-owned `LanguageFactExtractor` contract; the resolver receives only facts and normalized evidence, while source text remains available solely for code-chunk rendering.

**Tech Stack:** TypeScript 7.0.2, Node 22, existing native Tree-sitter parser boundary, canonical JSON codec, SHA-256 fact keys, SQLite `fact_blobs`.

**Spec:** [Phase14B revised design](<HOME>/code-atlas/docs/superpowers/specs/2026-09-07-phase14b-multilanguage-resolver-typeenvironment-v2-design.md), §§4, 5, 6, 7, 20, 21, 34, 37, 47.

## Global Constraints

- Facts contain objective syntax facts only: no selected targets, confidence, strategy decisions, candidate ranking, or speculative cross-file target.
- Required facts cover scopes/ownership, bindings/shadowing, imports/exports/modules, receivers/member chains, calls, constructors, assignments, parameters, returns, annotations, aliases, inheritance, interfaces, implementations, traits/impl ownership, Go receivers, Swift extensions, Dart mixins/extensions, namespaces, direct/static C function pointers, and relevant C++ ownership.
- Fact extraction is the only semantic syntax interpretation path. Resolver modules do not parse source, run regex semantics, or call Tree-sitter.
- Perform exactly one coordinated `factsSchemaVersion`/`factsVersion` update after the complete fact model is established.
- `parserIdentity` records parser runtime and grammar provenance. Semantic adapter changes belong to `resolutionVersion`.
- Old incompatible blobs are cache misses; read-only paths never repair or rewrite them.

### Task 1.1: Define the complete objective fact model

**Files:**
- Modify: `src/core/facts/facts.types.ts`
- Modify: `src/core/graph/parsers/types.ts` (language IDs and parser metadata only)
- Create: `test/helpers/phase14b-facts.ts`
- Test: `test/phase14b-facts-contract.test.ts`
- Modify: `test/phase14a-facts.test.ts` (supply empty Phase 14B arrays in existing fixtures)

**Interfaces:**
- Produces `LanguageId` as the union of the eleven target language IDs plus `tsx`.
- Produces `ParserIdentity = { language: LanguageId; runtimeName: "tree-sitter"; runtimeVersion: string; packageName: string; grammarName: string; grammarVersion: string }`. Exact package identity participates in fact identity; scoped package names are preserved verbatim.
- Produces `FactLocalId = string & { readonly __brand: "FactLocalId" }`; local IDs are blob-local and path-neutral.
- Produces the exact objective records shown in Step 3. All ownership references use local fact IDs, never DB row IDs or resolved cross-file targets.
- Extends `ParsedFactsBlob` with deterministic arrays for `expressions`, `members`, `assignments`, `parameters`, `returns`, `constructors`, `inheritances`, `implementations`, `aliases`, `modules`, and `namespaces` while retaining the existing arrays.
- Produces test helpers `range(line: number): SourceRangeFact`, `makeFacts(overrides?: Partial<ParsedFactsBlob>): ParsedFactsBlob`, and `expectation(facts: ParsedFactsBlob): FactCacheExpectation` for later fact/cache fixtures.

- [ ] **Step 1: Write the failing test**

```ts
test("ParsedFacts carries objective receiver, flow, ownership, and language-specific seeds", () => {
  const facts = makeFacts({
    expressions: [{ localId: "expression:1" as FactLocalId, kind: "identifier", text: "service", range: range(2) }],
    members: [{ localId: "member:1" as FactLocalId, receiverId: "expression:1" as FactLocalId, memberName: "refresh", memberKind: "method", access: "instance", range: range(2) }],
    assignments: [{ localId: "assignment:1" as FactLocalId, targetId: "binding:1" as FactLocalId, sourceExpressionId: "expression:1" as FactLocalId, assignmentKind: "declaration", range: range(1) }],
    implementations: [{ localId: "implementation:1" as FactLocalId, subjectId: "symbol:1" as FactLocalId, targetName: "Service", relationKind: "implements", range: range(1) }],
  });
  assert.equal(facts.members[0]?.receiverId, "expression:1");
  assert.equal(facts.implementations[0]?.relationKind, "implements");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-facts-contract.test.ts`

Expected: FAIL because the Phase14B fact arrays, exact record contracts, and expanded parser identity do not exist.

- [ ] **Step 3: Implement the complete typed fact contract**

Use only syntax-observable data. Optional fields capture absence of syntax, not failed semantic resolution. Keep `FACTS_SCHEMA_VERSION` and `FACTS_VERSION` unchanged in this task; Task 1.3 owns the single coordinated bump.

```ts
export type ExpressionFact = {
  localId: FactLocalId;
  kind: "identifier" | "literal" | "call" | "construct" | "member" | "type_ref" | "other";
  text?: string;
  ownerScopeId?: FactLocalId;
  range: SourceRangeFact;
};

export type MemberFact = {
  localId: FactLocalId;
  ownerSymbolId?: FactLocalId;
  receiverId?: FactLocalId;
  memberName: string;
  memberKind: "field" | "method" | "property";
  access: "instance" | "static" | "extension";
  range: SourceRangeFact;
};

export type AssignmentFact = {
  localId: FactLocalId;
  targetId: FactLocalId;
  sourceExpressionId?: FactLocalId;
  sourceName?: string;
  assignmentKind: "declaration" | "reassignment" | "alias" | "function_pointer";
  range: SourceRangeFact;
};

export type ParameterFact = {
  localId: FactLocalId;
  ownerSymbolId: FactLocalId;
  name: string;
  bindingId?: FactLocalId;
  typeText?: string;
  index: number;
  receiverKind?: "method_receiver" | "go_receiver";
  range: SourceRangeFact;
};

export type ReturnFact = {
  localId: FactLocalId;
  ownerSymbolId: FactLocalId;
  expressionId?: FactLocalId;
  typeText?: string;
  range: SourceRangeFact;
};

export type ConstructorFact = {
  localId: FactLocalId;
  ownerSymbolId?: FactLocalId;
  constructedTypeName: string;
  callExpressionId?: FactLocalId;
  resultBindingId?: FactLocalId;
  range: SourceRangeFact;
};

export type InheritanceFact = {
  localId: FactLocalId;
  subjectId: FactLocalId;
  targetName: string;
  relationKind: "extends" | "base" | "trait" | "protocol" | "mixin";
  range: SourceRangeFact;
};

export type ImplementationFact = {
  localId: FactLocalId;
  subjectId: FactLocalId;
  targetName: string;
  relationKind: "implements" | "interface" | "trait_impl" | "protocol_conformance" | "extension" | "mixin";
  range: SourceRangeFact;
};

export type AliasFact = {
  localId: FactLocalId;
  aliasName: string;
  targetName: string;
  targetId?: FactLocalId;
  aliasKind: "import" | "type" | "namespace" | "value";
  range: SourceRangeFact;
};

export type ModuleFact = {
  localId: FactLocalId;
  name: string;
  moduleKind: "file" | "module" | "package" | "namespace";
  exported: boolean;
  range: SourceRangeFact;
};

export type NamespaceFact = {
  localId: FactLocalId;
  name: string;
  ownerId?: FactLocalId;
  range: SourceRangeFact;
};

export type ParsedFactsBlob = {
  factsSchemaVersion: string;
  factsVersion: string;
  contentHash: string;
  language: LanguageId;
  parserIdentity: ParserIdentity;
  parseStatus: ParseStatus;
  parserDiagnostics: string[];
  symbols: ParsedSymbolFact[];
  containmentScopes: ContainmentScopeFact[];
  imports: ImportFact[];
  exports: ExportFact[];
  references: ReferenceFact[];
  callSites: CallSiteFact[];
  bindingSeeds: BindingSeedFact[];
  declaredTypeAnnotations: DeclaredTypeAnnotationFact[];
  expressions: readonly ExpressionFact[];
  members: readonly MemberFact[];
  assignments: readonly AssignmentFact[];
  parameters: readonly ParameterFact[];
  returns: readonly ReturnFact[];
  constructors: readonly ConstructorFact[];
  inheritances: readonly InheritanceFact[];
  implementations: readonly ImplementationFact[];
  aliases: readonly AliasFact[];
  modules: readonly ModuleFact[];
  namespaces: readonly NamespaceFact[];
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-facts-contract.test.ts test/phase14a-facts.test.ts`

Expected: PASS, including existing Phase14A fact construction after its fixture factory supplies empty arrays and complete parser identity for the new required fields.

- [ ] **Step 5: Commit**

```bash
git add src/core/facts/facts.types.ts src/core/graph/parsers/types.ts test/helpers/phase14b-facts.ts test/phase14b-facts-contract.test.ts test/phase14a-facts.test.ts
git commit -m "feat(facts): define Phase 14B objective fact model"
```

### Task 1.2: Define language-owned fact extraction and parser identity dispatch

**Files:**
- Create: `src/core/facts/language-fact-extractor.ts`
- Modify: `src/core/facts/facts-extractor.ts`
- Modify: `src/core/graph/parsers/code-parser.ts`
- Test: `test/phase14b-fact-extractor-dispatch.test.ts`

**Interfaces:**
- Produces `type LanguageFactExtractorInput = { source: string; filePath: string; language: LanguageId; contentHash: string; factsVersion: string; factsSchemaVersion: string }`.
- Produces `type LanguageFactExtractor = { readonly language: LanguageId; extract(input: LanguageFactExtractorInput): FactExtractionOutcome }`; the singular `language` field is authoritative, so multi-language families export one wrapper extractor per language ID.
- Produces `getLanguageFactExtractor(language: LanguageId): LanguageFactExtractor | undefined`.
- `extractParsedFacts(input: FactExtractionInput)` dispatches to exactly one registered extractor and returns `infrastructure_failure` when no parser/extractor exists.

- [ ] **Step 1: Write the failing test**

```ts
test("fact extraction dispatches by registered language and preserves parser identity", () => {
  const result = extractParsedFacts({ source: "def run():\n  return 1\n", filePath: "src/run.py", language: "python", contentHash: "python-1", factsVersion: "2.0.0", factsSchemaVersion: "2.0.0" });
  assert.equal(result.kind, "facts");
  if (result.kind === "facts") {
    assert.equal(result.facts.language, "python");
    assert.equal(result.facts.parserIdentity.language, "python");
    assert.equal(result.facts.parserIdentity.packageName, "tree-sitter-python");
    assert.equal(result.facts.parserIdentity.grammarName, "tree-sitter-python");
    assert.equal(result.facts.parserIdentity.runtimeName, "tree-sitter");
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-fact-extractor-dispatch.test.ts`

Expected: FAIL because `python` is not a `SupportedLanguage` and the extractor is hardcoded to JavaScript/TypeScript AST node names.

- [ ] **Step 3: Implement dispatch without a source side channel**

Move parser selection and grammar metadata behind the registered extractor. Keep `parseSource` as the single parser entry point used by extractors. Make each extractor return only objective facts and parser diagnostics; do not add resolution targets or confidence fields.

```ts
export type LanguageFactExtractor = {
  readonly language: LanguageId;
  extract(input: LanguageFactExtractorInput): FactExtractionOutcome;
};

export function extractParsedFacts(input: FactExtractionInput): FactExtractionOutcome {
  const extractor = getLanguageFactExtractor(input.language);
  return extractor === undefined
    ? { kind: "infrastructure_failure", reason: "parser_or_extractor_unavailable" }
    : extractor.extract(input);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-fact-extractor-dispatch.test.ts test/phase14a-facts.test.ts`

Expected: PASS for existing JS/TS/TSX and the first registered non-ECMAScript smoke extractor.

- [ ] **Step 5: Commit**

```bash
git add src/core/facts/language-fact-extractor.ts src/core/facts/facts-extractor.ts src/core/graph/parsers/code-parser.ts test/phase14b-fact-extractor-dispatch.test.ts
git commit -m "feat(facts): dispatch extraction through language contracts"
```

### Task 1.3: Add fact codec, identity, and cache compatibility for v2

**Files:**
- Modify: `src/core/facts/facts-codec.ts`
- Modify: `src/core/facts/facts-identity.ts`
- Modify: `src/core/indexing/index-pipeline.service.ts` only for version fields passed to existing cache expectations
- Test: `test/phase14b-facts-cache.test.ts`
- Modify: `src/core/repository/index-version.ts` (sole coordinated facts version bump)
- Modify: `test/phase14a-cache.test.ts` (v2 cache expectation)
- Modify: `test/phase14a-single-parse.test.ts` (v2 cache expectation)

**Interfaces:**
- `factBlobKey` continues to hash `contentHash + language + parserIdentity + factsVersion + factsSchemaVersion` and remains path-independent.
- `decodeFacts` rejects a missing/new-shape mismatch with a structured miss reason; it never coerces legacy fact arrays into Phase14B facts.
- `encodeFacts` canonicalizes all new arrays and nested records deterministically.

- [ ] **Step 1: Write the failing test**

```ts
test("v2 facts round-trip and legacy facts miss without mutation", async () => {
  const v2 = makeFacts({ factsSchemaVersion: "2.0.0", factsVersion: "2.0.0" });
  const encoded = encodeFacts(v2);
  assert.deepEqual(decodeFacts(encoded, { key: factBlobKey(v2), ...expectation(v2) }), { kind: "hit", facts: v2 });
  const legacy = makeFacts({ factsSchemaVersion: "1.0.0", factsVersion: "1.0.0" });
  assert.notEqual(factBlobKey(v2), factBlobKey(legacy));
  assert.equal(decodeFacts(encodeFacts(legacy), { key: factBlobKey(v2), ...expectation(v2) }).kind, "miss");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-facts-cache.test.ts`

Expected: FAIL because the codec does not validate or encode the new fact arrays and current pipeline uses the storage schema as `factsSchemaVersion`.

- [ ] **Step 3: Implement strict v2 codec and identity**

Add validators for every new discriminated record, preserve all miss reasons, and use `CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion` in cache expectations/extraction. This task owns the one coordinated facts bump: change the currently valid facts schema/version values from `1.0.0` to `2.0.0` only after the new model is present. Keep `factBlobKey` canonical JSON and never include repository-relative path.

```ts
export const FACTS_SCHEMA_VERSION = "2.0.0";
export const FACTS_VERSION = "2.0.0";

export function factBlobKey(facts: Pick<ParsedFactsBlob, "contentHash" | "language" | "parserIdentity" | "factsVersion" | "factsSchemaVersion">): string {
  return sha256(canonicalJson({
    contentHash: facts.contentHash,
    language: facts.language,
    parserIdentity: facts.parserIdentity,
    factsVersion: facts.factsVersion,
    factsSchemaVersion: facts.factsSchemaVersion,
  }));
}

const expected = {
  factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion,
  factsSchemaVersion: CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion,
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-facts-cache.test.ts test/phase14a-cache.test.ts test/phase14a-single-parse.test.ts`

Expected: PASS with v2 round-trip, corrupted-row repair in mutating flow, path-independent keys, and unchanged single-parse behavior.

- [ ] **Step 5: Commit**

```bash
git add src/core/facts/facts-codec.ts src/core/facts/facts-identity.ts src/core/indexing/index-pipeline.service.ts src/core/repository/index-version.ts test/phase14b-facts-cache.test.ts test/phase14a-cache.test.ts test/phase14a-single-parse.test.ts
git commit -m "feat(facts): version and validate semantic fact payloads"
```

## Track checkpoint

Track 14B-1 is complete when the new fact model, v2 codec/identity, and language extraction dispatch are committed with strict legacy-miss behavior. Track 14B-2 owns the facts-path no-source-side-channel implementation.
