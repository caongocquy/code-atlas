# Phase 14B-1 ParsedFacts Semantic Sufficiency Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Expand the persisted objective fact contract so every Phase14B adapter can resolve its declared semantic floor without reparsing source text.

**Architecture:** Preserve path-neutral immutable fact blobs and generation-scoped file bindings. Replace the current JS/TS-only extractor dispatch with a language-owned `LanguageFactExtractor` contract; the resolver receives only facts and normalized evidence, while source text remains available solely for code-chunk rendering.

**Tech Stack:** TypeScript 7.0.2, Node 22, existing native Tree-sitter parser boundary, canonical JSON codec, SHA-256 fact keys, SQLite `fact_blobs`.

**Spec:** [Phase14B revised design](<HOME>/code-atlas/docs/superpowers/specs/2026-09-07-phase14b-multilanguage-resolver-typeenvironment-v2-design-revised.md), §§4, 5, 6, 7, 20, 21, 34, 37, 47.

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

**Interfaces:**
- Produces `LanguageId` as the union of the eleven target language IDs plus `tsx`.
- Produces `FactLocalId` variants for `expression`, `member`, `assignment`, `parameter`, `return`, `constructor`, `inheritance`, `implementation`, `alias`, `module`, and `namespace` facts.
- Produces exact fact records `ExpressionFact`, `MemberFact`, `AssignmentFact`, `ParameterFact`, `ReturnFact`, `ConstructorFact`, `InheritanceFact`, `ImplementationFact`, `AliasFact`, `ModuleFact`, and `NamespaceFact`, each carrying a `localId` and `SourceRangeFact`; ownership uses local fact IDs, never DB row IDs.
- Extends `ParsedFactsBlob` with deterministic arrays for those records while retaining the existing arrays.
- Extends `IndexVersionDomains` with `factsSchemaVersion` as defined by Track 14B-0.
- Produces test helpers `range(line: number): SourceRangeFact`, `makeFacts(overrides?: Partial<ParsedFactsBlob>): ParsedFactsBlob`, and `expectation(facts: ParsedFactsBlob): FactCacheExpectation` for every later fact/cache fixture.

- [ ] **Step 1: Write the failing test**

```ts
test("ParsedFacts carries objective receiver, flow, ownership, and language-specific seeds", () => {
  const facts = makeFacts({
    expressions: [{ localId: "expression:1", kind: "identifier", text: "service", range: range(2) }],
    members: [{ localId: "member:1", receiverId: "expression:1", memberName: "refresh", memberKind: "method", access: "instance", range: range(2) }],
    assignments: [{ localId: "assignment:1", targetId: "binding:1", sourceExpressionId: "expression:1", assignmentKind: "declaration", range: range(1) }],
    implementations: [{ localId: "implementation:1", subjectId: "symbol:1", targetName: "Service", relationKind: "interface", range: range(1) }],
  });
  assert.equal(facts.members[0]?.receiverId, "expression:1");
  assert.equal(facts.implementations[0]?.relationKind, "interface");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-facts-contract.test.ts`

Expected: FAIL because the new fact arrays and record types do not exist.

- [ ] **Step 3: Implement the minimal typed model**

Add discriminated records with explicit ownership fields, optional language-specific modifiers, and stable source ranges. Keep free-form `kind` only where syntax differs by language; use explicit relation/access/role unions for resolver-relevant decisions. Extend `ParsedFactsBlob` arrays and preserve deterministic array ordering as an extractor responsibility.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-facts-contract.test.ts test/phase14a-facts.test.ts`

Expected: PASS, including existing Phase14A fact construction after its fixture factory supplies empty arrays for the new fields.

- [ ] **Step 5: Commit**

```bash
git add src/core/facts/facts.types.ts src/core/graph/parsers/types.ts test/phase14b-facts-contract.test.ts test/phase14a-facts.test.ts
git commit -m "feat(facts): define Phase 14B objective fact model"
```

### Task 1.2: Define language-owned fact extraction and parser identity dispatch

**Files:**
- Create: `src/core/facts/language-fact-extractor.ts`
- Modify: `src/core/facts/facts-extractor.ts`
- Modify: `src/core/graph/parsers/code-parser.ts`
- Test: `test/phase14b-fact-extractor-dispatch.test.ts`

**Interfaces:**
- Produces `type LanguageFactExtractorInput = { source: string; language: LanguageId; contentHash: string; factsVersion: string; factsSchemaVersion: string }`.
- Produces `type LanguageFactExtractor = { readonly language: LanguageId; extract(input: LanguageFactExtractorInput): FactExtractionOutcome }`.
- Produces `getLanguageFactExtractor(language: LanguageId): LanguageFactExtractor | undefined`.
- `extractParsedFacts(input: FactExtractionInput)` dispatches to exactly one registered extractor and returns `infrastructure_failure` when no parser/extractor exists.

- [ ] **Step 1: Write the failing test**

```ts
test("fact extraction dispatches by registered language and preserves parser identity", () => {
  const result = extractParsedFacts({ source: "def run():\n  return 1\n", language: "python", contentHash: "python-1", factsVersion: "2.0.0", factsSchemaVersion: "2.0.0" });
  assert.equal(result.kind, "facts");
  if (result.kind === "facts") {
    assert.equal(result.facts.language, "python");
    assert.equal(result.facts.parserIdentity.language, "python");
    assert.equal(result.facts.parserIdentity.grammarName, "tree-sitter-python");
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-fact-extractor-dispatch.test.ts`

Expected: FAIL because `python` is not a `SupportedLanguage` and the extractor is hardcoded to JavaScript/TypeScript AST node names.

- [ ] **Step 3: Implement dispatch without a source side channel**

Move parser selection and grammar metadata behind the registered extractor. Keep `parseSource` as the single parser entry point used by extractors. Make each extractor return only objective facts and parser diagnostics; do not add resolution targets or confidence fields.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-fact-extractor-dispatch.test.ts test/phase14a-facts.test.ts`

Expected: PASS for existing JS/TS/TSX and the first registered non-ECMAScript smoke extractor.

- [ ] **Step 5: Commit**

```bash
git add src/core/facts/language-fact-extractor.ts src/core/facts/facts-extractor.ts src/core/graph/parsers/code-parser.ts test/phase14b-fact-extractor-dispatch.test.ts test/phase14a-facts.test.ts
git commit -m "feat(facts): dispatch extraction through language contracts"
```

### Task 1.3: Add fact codec, identity, and cache compatibility for v2

**Files:**
- Modify: `src/core/facts/facts-codec.ts`
- Modify: `src/core/facts/facts-identity.ts`
- Modify: `src/core/indexing/index-pipeline.service.ts` only for version fields passed to existing cache expectations
- Test: `test/phase14b-facts-cache.test.ts`

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

Add validators for every new discriminated record, preserve all miss reasons, and use `CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion` in cache expectations/extraction. Keep `factBlobKey` canonical JSON and never include repository-relative path.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-facts-cache.test.ts test/phase14a-cache.test.ts test/phase14a-single-parse.test.ts`

Expected: PASS with v2 round-trip, corrupted-row repair in mutating flow, path-independent keys, and unchanged single-parse behavior.

- [ ] **Step 5: Commit**

```bash
git add src/core/facts/facts-codec.ts src/core/facts/facts-identity.ts src/core/indexing/index-pipeline.service.ts test/phase14b-facts-cache.test.ts test/phase14a-cache.test.ts test/phase14a-single-parse.test.ts
git commit -m "feat(facts): version and validate semantic fact payloads"
```

## Track checkpoint

Track 14B-1 is complete when the new fact model, v2 codec/identity, and language extraction dispatch are committed with strict legacy-miss behavior. Track 14B-2 owns the facts-path no-source-side-channel implementation.
