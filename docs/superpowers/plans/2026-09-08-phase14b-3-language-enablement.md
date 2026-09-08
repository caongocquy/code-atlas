# Phase 14B-3 Language Enablement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable all eleven target language families through scanner, parser, objective extraction, semantic adapter, capability profile, and conformance fixtures.

**Architecture:** Keep one native `tree-sitter@0.25.1` parser runtime and register one grammar adapter per language. Family helpers may normalize shared concepts, but each language owns grammar node mapping and conservative unsupported behavior. Package integration is single-owner; family modules can be developed independently after the shared facts/resolver contracts land.

**Tech Stack:** Node 22, TypeScript 7.0.2, pnpm 11.22.0, native Tree-sitter Node bindings, pinned grammar packages, `node:test` fixtures under `test/fixtures/phase14b/`.

**Spec:** [Phase14B revised design](<HOME>/code-atlas/docs/superpowers/specs/2026-09-07-phase14b-multilanguage-resolver-typeenvironment-v2-design.md), §§1, 5, 6, 18–20, 35, 37–38, 42–44.

## Global Constraints

- Scanner-only or parser-only recognition does not count as support.
- Every language must pass its applicable floor before public support is claimed.
- Unsupported compiler-grade constructs produce `unsupported`, `unknown`, or `ambiguous`, never a guessed edge.
- No family adapter reparses source or uses source-text regex semantics.
- `parserIdentity` records parser runtime/grammar provenance; semantic adapter changes use `resolutionVersion`.
- Only Task 3.1 owns `package.json`, `pnpm-lock.yaml`, `src/core/graph/parsers/languages.ts`, and `src/core/graph/parsers/registry.ts`.
- The following registry candidates were verified on 2026-09-08: `tree-sitter-python@0.25.0`, `tree-sitter-java@0.23.5`, `tree-sitter-kotlin@0.3.8`, `tree-sitter-go@0.25.0`, `tree-sitter-rust@0.24.0`, `tree-sitter-swift@0.7.1`, `@driftlog/tree-sitter-dart@1.0.4`, `tree-sitter-c@0.24.1`, and `tree-sitter-cpp@0.23.4`.
- Native package loading must pass against `tree-sitter@0.25.1`, Node 22, macOS arm64, Linux x64, and the packed artifact before any language is marked supported. A failed ABI/package test blocks the track; it does not authorize switching to WebAssembly or another parser architecture.

### Grammar package decision record

| Language | Exact package/artifact | Runtime and packaging rule |
|---|---|---|
| Python | `tree-sitter-python@0.25.0` | Native Node binding loaded by `tree-sitter@0.25.1`; package must load on Node22 and be included by npm pack; no project postinstall. |
| Java | `tree-sitter-java@0.23.5` | Native Node binding under the same runtime; verify ABI and packed install before registry advertisement. |
| Kotlin | `tree-sitter-kotlin@0.3.8` | Native Node binding under the same runtime; grammar ambiguity remains an adapter diagnostic, not a parser replacement. |
| Go | `tree-sitter-go@0.25.0` | Native Node binding; package metadata includes its native build fallback, so the packed smoke must prove the installed artifact loads without a repository build hook. |
| Rust | `tree-sitter-rust@0.24.0` | Native Node binding; verify the package's generated binding loads against the pinned runtime before use. |
| Swift | `tree-sitter-swift@0.7.1` | Native package candidate; its published JavaScript guidance references an older Tree-sitter runtime, so the Task 3.1 ABI test is a hard gate. No WASM fallback is introduced silently. |
| Dart | `@driftlog/tree-sitter-dart@1.0.4` | Native prebuilt N-API artifact with documented macOS arm64/Linux x64 coverage; verify packed install and source-build fallback behavior without adding a project postinstall. |
| C | `tree-sitter-c@0.24.1` | Native Node binding under the pinned runtime; verify packed artifact and Node22 load. |
| C++ | `tree-sitter-cpp@0.23.4` | Native Node binding under the pinned runtime; verify packed artifact and Node22 load. |

All candidates are regular runtime dependencies. The project ships `dist` only, so the parser packages must bring their generated/native artifacts through the dependency install; no grammar source generation or Emscripten step is part of the project build.

### Task 3.1: Validate native grammar packages and create the registry-independent language fixture harness

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/core/graph/parsers/types.ts`
- Modify: `src/core/graph/parsers/languages.ts`
- Modify: `src/core/graph/parsers/registry.ts`
- Modify: `src/core/graph/parsers/code-parser.ts`
- Create: `.github/workflows/phase14b-parser-platform.yml`
- Create: `test/helpers/phase14b-language-fixtures.ts`
- Test: `test/phase14b-parser-packaging.test.ts`

**Interfaces:**
- `SupportedLanguage` includes `typescript`, `tsx`, `javascript`, `python`, `java`, `kotlin`, `go`, `rust`, `swift`, `dart`, `c`, and `cpp`.
- Parser metadata uses `ParserIdentity` from Task 1.1: `{ language, runtimeName, runtimeVersion, packageName, grammarName, grammarVersion }`. `packageName` is the exact npm identity and participates in `parserIdentity`; scoped names such as `@driftlog/tree-sitter-dart` are never normalized away.
- Each `LanguageConfig` keeps the existing parser entry-point shape and adds metadata with exact package/runtime provenance plus its extensions.
- `type LanguageFixtureDefinition = { name: string; cases: readonly { filePath: string; source: string; language: LanguageId }[]; sites: readonly ResolutionSiteIdentity[] }`.
- `parserFixtures: Readonly<Record<string, LanguageFixtureDefinition>>` and `targetLanguages: readonly LanguageId[]` are created in `test/helpers/phase14b-language-fixtures.ts`.
- `type LanguageFixtureDependencies = { extractors: readonly LanguageFactExtractor[]; adapter: LanguageSemanticAdapter; memoMode?: "cold" | "warm"; parallel?: boolean }`.
- `type LanguageFixtureResult = { decisions: readonly ResolutionDecision[]; usedSourceSemanticFallback: boolean; floorPassed: boolean; normalizedFacts: readonly ParsedFactsBlob[] }`.
- `runLanguageFixture(name: string, deps: LanguageFixtureDependencies): Promise<LanguageFixtureResult>` is **registry independent**: it selects an extractor only from `deps.extractors`, checks `extractor.language === fixtureCase.language`, calls `deps.adapter.normalizeFile`, then uses the Track 14B-2 TypeEnvironment/resolver APIs. It does not call `getLanguageFactExtractor` or `getSemanticAdapter`; Task 3.10 owns those registries later.

- [ ] **Step 1: Write the failing test**

```ts
test("all target grammars load through the native parser runtime with exact package identity", () => {
  for (const fixture of Object.values(parserFixtures)) {
    for (const item of fixture.cases) {
      const parsed = parseSource(item.source, item.filePath);
      assert.ok(parsed, item.filePath);
      assert.equal(parsed.adapter.language, item.language);
      assert.equal(parsed.tree.rootNode.hasError, false, item.filePath);
      assert.equal(parsed.adapter.metadata.runtimeName, "tree-sitter");
      assert.ok(parsed.adapter.metadata.packageName.length > 0);
    }
  }
  assert.equal(getLanguageConfig("lib/main.dart")?.metadata.packageName, "@driftlog/tree-sitter-dart");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-parser-packaging.test.ts`

Expected: FAIL because non-ECMAScript grammars and complete parser metadata are not registered.

- [ ] **Step 3: Add exact dependencies, metadata, parser registry entries, and fixture harness**

Use exact package identity separately from grammar name. Apply the same metadata fields to existing JS/TS/TSX registry entries using their already-declared package/version constants. Do not add postinstall scripts or a second parser runtime.

```ts
export const LANGUAGE_CONFIGS: readonly LanguageConfig[] = [
  { language: "python", extensions: [".py"], metadata: { runtimeName: "tree-sitter", runtimeVersion: "0.25.1", packageName: "tree-sitter-python", grammarName: "tree-sitter-python", grammarVersion: "0.25.0" } },
  { language: "java", extensions: [".java"], metadata: { runtimeName: "tree-sitter", runtimeVersion: "0.25.1", packageName: "tree-sitter-java", grammarName: "tree-sitter-java", grammarVersion: "0.23.5" } },
  { language: "kotlin", extensions: [".kt", ".kts"], metadata: { runtimeName: "tree-sitter", runtimeVersion: "0.25.1", packageName: "tree-sitter-kotlin", grammarName: "tree-sitter-kotlin", grammarVersion: "0.3.8" } },
  { language: "go", extensions: [".go"], metadata: { runtimeName: "tree-sitter", runtimeVersion: "0.25.1", packageName: "tree-sitter-go", grammarName: "tree-sitter-go", grammarVersion: "0.25.0" } },
  { language: "rust", extensions: [".rs"], metadata: { runtimeName: "tree-sitter", runtimeVersion: "0.25.1", packageName: "tree-sitter-rust", grammarName: "tree-sitter-rust", grammarVersion: "0.24.0" } },
  { language: "swift", extensions: [".swift"], metadata: { runtimeName: "tree-sitter", runtimeVersion: "0.25.1", packageName: "tree-sitter-swift", grammarName: "tree-sitter-swift", grammarVersion: "0.7.1" } },
  { language: "dart", extensions: [".dart"], metadata: { runtimeName: "tree-sitter", runtimeVersion: "0.25.1", packageName: "@driftlog/tree-sitter-dart", grammarName: "tree-sitter-dart", grammarVersion: "1.0.4" } },
  { language: "c", extensions: [".c", ".h"], metadata: { runtimeName: "tree-sitter", runtimeVersion: "0.25.1", packageName: "tree-sitter-c", grammarName: "tree-sitter-c", grammarVersion: "0.24.1" } },
  { language: "cpp", extensions: [".cc", ".cpp", ".cxx", ".hpp"], metadata: { runtimeName: "tree-sitter", runtimeVersion: "0.25.1", packageName: "tree-sitter-cpp", grammarName: "tree-sitter-cpp", grammarVersion: "0.23.4" } },
];

export async function runLanguageFixture(name: string, deps: LanguageFixtureDependencies): Promise<LanguageFixtureResult> {
  const fixture = parserFixtures[name];
  if (!fixture) throw new Error(`unknown Phase14B fixture: ${name}`);
  const normalizedFacts: ParsedFactsBlob[] = [];
  for (const item of fixture.cases) {
    const extractor = deps.extractors.find((candidate) => candidate.language === item.language);
    if (!extractor) throw new Error(`missing extractor for ${item.language}`);
    const outcome = extractor.extract(factExtractorInput(item));
    if (outcome.kind !== "facts") throw new Error(`fact extraction failed for ${item.filePath}: ${outcome.kind}`);
    normalizedFacts.push(outcome.facts);
  }
  return runFixtureThroughResolver(fixture, normalizedFacts, deps.adapter, deps.memoMode, deps.parallel);
}
```

Task 3.1 also owns the test-helper signatures `factExtractorInput(item): LanguageFactExtractorInput` and `runFixtureThroughResolver(fixture: LanguageFixtureDefinition, facts: readonly ParsedFactsBlob[], adapter: LanguageSemanticAdapter, memoMode?: "cold" | "warm", parallel?: boolean): Promise<LanguageFixtureResult>` in `test/helpers/phase14b-language-fixtures.ts`.

```yaml
name: Phase 14B parser platform
on: [push, pull_request]
jobs:
  linux-x64-native-parsers:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22 }
      - run: corepack enable
      - run: pnpm install --frozen-lockfile
      - run: pnpm run build
      - run: node --import tsx/esm --test test/phase14b-parser-packaging.test.ts
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install --frozen-lockfile && node --import tsx/esm --test test/phase14b-parser-packaging.test.ts`

Expected: PASS locally on macOS arm64 for grammar loading and exact metadata. Linux x64 executes the same packaging test in `.github/workflows/phase14b-parser-platform.yml`; failure on either supported platform blocks public language support rather than triggering a parser substitution.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/core/graph/parsers/types.ts src/core/graph/parsers/languages.ts src/core/graph/parsers/registry.ts src/core/graph/parsers/code-parser.ts .github/workflows/phase14b-parser-platform.yml test/helpers/phase14b-language-fixtures.ts test/phase14b-parser-packaging.test.ts
git commit -m "feat(parser): register Phase 14B language grammars"
```

### Task 3.2: Implement ECMAScript facts and adapter floor

**Files:**
- Create: `src/core/facts/extractors/ecmascript.ts`
- Create: `src/core/graph/resolver/adapters/ecmascript.ts`
- Create: `test/fixtures/phase14b/ecmascript/expected.json`
- Create: `test/phase14b-language-ecmascript.test.ts`

**Interfaces:**
- Because `LanguageFactExtractor.language` is singular, exports three wrappers: `javascriptFactExtractor`, `typescriptFactExtractor`, and `tsxFactExtractor`.
- Owns `extractEcmascriptFacts(input: LanguageFactExtractorInput): FactExtractionOutcome`; each wrapper passes an input whose `language` matches the wrapper exactly.
- Exports `ecmascriptSemanticAdapter` for `javascript`, `typescript`, and `tsx`.
- Owns `normalizeEcmascriptFacts(facts: ParsedFactsBlob, context: AdapterContext): SemanticEvidenceBatch`.
- Covers lexical bindings/shadowing, imports/exports, direct calls, constructors, assignments, parameters, returns, receiver/member chains, aliases, declared types, interfaces, implements, type aliases, and JSX-preserving parse status.

- [ ] **Step 1: Write the failing test**

```ts
test("ECMAScript floor resolves typed construction and member calls without name guesses", async () => {
  const result = await runLanguageFixture("ecmascript", {
    extractors: [javascriptFactExtractor, typescriptFactExtractor, tsxFactExtractor],
    adapter: ecmascriptSemanticAdapter,
  });
  assert.deepEqual(result.decisions.map((decision) => decision.status), ["resolved"]);
  assert.equal(result.decisions[0]?.status === "resolved" ? result.decisions[0].confidence : undefined, "strong");
  assert.equal(result.usedSourceSemanticFallback, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-language-ecmascript.test.ts`

Expected: FAIL because objective assignment/member/parameter/return facts and the ECMAScript semantic adapter do not exist.

- [ ] **Step 3: Implement one shared extractor body behind three language-exact wrappers**

```ts
export function extractEcmascriptFacts(input: LanguageFactExtractorInput): FactExtractionOutcome {
  return extractEcmascriptTreeFacts(parseSource(input.source, input.filePath), input);
}

export const javascriptFactExtractor: LanguageFactExtractor = { language: "javascript", extract: extractEcmascriptFacts };
export const typescriptFactExtractor: LanguageFactExtractor = { language: "typescript", extract: extractEcmascriptFacts };
export const tsxFactExtractor: LanguageFactExtractor = { language: "tsx", extract: extractEcmascriptFacts };

export const ecmascriptSemanticAdapter: LanguageSemanticAdapter = {
  adapterId: "ecmascript-phase14b",
  adapterVersion: 1,
  languages: ["javascript", "typescript", "tsx"],
  capabilities: () => ECMASCRIPT_CAPABILITIES,
  normalizeFile: normalizeEcmascriptFacts,
};
```

Task 3.2 owns `extractEcmascriptTreeFacts(parsed: ParsedSource | undefined, input: LanguageFactExtractorInput): FactExtractionOutcome` and `normalizeEcmascriptFacts(facts: ParsedFactsBlob, context: AdapterContext): SemanticEvidenceBatch`; neither function reparses source outside `parseSource`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-language-ecmascript.test.ts test/phase14b-facts-contract.test.ts`

Expected: PASS for JavaScript, TypeScript, and TSX floor cases with wrapper identity matching each parsed language.

- [ ] **Step 5: Commit**

```bash
git add src/core/facts/extractors/ecmascript.ts src/core/graph/resolver/adapters/ecmascript.ts test/fixtures/phase14b/ecmascript/expected.json test/phase14b-language-ecmascript.test.ts
git commit -m "feat(resolver): enable ECMAScript semantic adapter"
```

### Task 3.3: Implement Python family floor

**Files:**
- Create: `src/core/facts/extractors/python.ts`
- Create: `src/core/graph/resolver/adapters/python.ts`
- Create: `test/fixtures/phase14b/python/expected.json`
- Create: `test/phase14b-language-python.test.ts`

**Interfaces:**
- Exports `pythonFactExtractor` and `pythonSemanticAdapter` using `tree-sitter-python@0.25.0`.
- Owns `extractPythonFacts(parsed: ParsedSource | undefined, input: LanguageFactExtractorInput): FactExtractionOutcome` and `normalizePythonFacts(facts: ParsedFactsBlob, context: AdapterContext): SemanticEvidenceBatch`.
- Covers imports, aliases, classes, `self` members, assignments, annotations, parameters, returns, constructors, direct calls, and explicit unsupported dynamic/runtime cases.

- [ ] **Step 1: Write the failing test**

```ts
test("Python floor resolves annotation-backed self member and preserves dynamic uncertainty", async () => {
  const result = await runLanguageFixture("python", { extractors: [pythonFactExtractor], adapter: pythonSemanticAdapter });
  assert.equal(result.decisions.find((item) => item.site === "typed-member")?.status, "resolved");
  assert.equal(result.decisions.find((item) => item.site === "dynamic-member")?.status, "unknown");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-language-python.test.ts`

Expected: FAIL because Python has no extractor, registry adapter, or facts support.

- [ ] **Step 3: Implement Python extractor and adapter**

Use Python AST node fields only; do not execute Python or infer runtime monkey-patching. Mark runtime-dependent dispatch unsupported/unknown and retain annotation/class/import evidence.

```ts
export const pythonFactExtractor: LanguageFactExtractor = {
  language: "python",
  extract: (input) => extractPythonFacts(parseSource(input.source, input.filePath), input),
};

export const pythonSemanticAdapter: LanguageSemanticAdapter = {
  adapterId: "python-phase14b",
  adapterVersion: 1,
  languages: ["python"],
  capabilities: () => PYTHON_CAPABILITIES,
  normalizeFile: (facts, context) => normalizePythonFacts(facts, context),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-language-python.test.ts`

Expected: PASS for floor, ambiguity, unknown, budget, and deterministic repeated fixtures.

- [ ] **Step 5: Commit**

```bash
git add src/core/facts/extractors/python.ts src/core/graph/resolver/adapters/python.ts test/fixtures/phase14b/python/expected.json test/phase14b-language-python.test.ts
git commit -m "feat(resolver): enable Python semantic floor"
```

### Task 3.4: Implement JVM family floor

**Files:**
- Create: `src/core/facts/extractors/java.ts`
- Create: `src/core/facts/extractors/kotlin.ts`
- Create: `src/core/graph/resolver/adapters/jvm.ts`
- Create: `test/fixtures/phase14b/java/expected.json`
- Create: `test/fixtures/phase14b/kotlin/expected.json`
- Create: `test/phase14b-language-jvm.test.ts`

**Interfaces:**
- Exports `javaFactExtractor`, `kotlinFactExtractor`, and `jvmSemanticAdapter` using `tree-sitter-java@0.23.5` and `tree-sitter-kotlin@0.3.8`.
- Owns `extractJavaFacts(input: LanguageFactExtractorInput): FactExtractionOutcome`, `extractKotlinFacts(input: LanguageFactExtractorInput): FactExtractionOutcome`, and `normalizeJvmFacts(facts: ParsedFactsBlob, context: AdapterContext): SemanticEvidenceBatch`.
- Covers packages/imports, classes/interfaces, extends/implements, constructors/primary constructors, fields/members, parameters/returns, nullable types, Kotlin objects/companions, typealiases, and conservative extension/overload outcomes.

- [ ] **Step 1: Write the failing test**

```ts
test("JVM floor resolves declared member ownership and does not guess Kotlin overloads", async () => {
  const result = await runLanguageFixture("jvm", { extractors: [javaFactExtractor, kotlinFactExtractor], adapter: jvmSemanticAdapter });
  assert.equal(result.decisions.find((item) => item.site === "java-member")?.status, "resolved");
  assert.equal(result.decisions.find((item) => item.site === "kotlin-overload")?.status, "ambiguous");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-language-jvm.test.ts`

Expected: FAIL because Java/Kotlin are not registered or extracted.

- [ ] **Step 3: Implement separate grammar mappings behind shared JVM evidence helpers**

Keep Java and Kotlin parser queries separate. Normalize only shared package/import/type/member facts. Treat extension functions, overload selection without enough declared information, and compiler-only dispatch as explicit uncertainty.

```ts
export const javaFactExtractor: LanguageFactExtractor = { language: "java", extract: (input) => extractJavaFacts(input) };
export const kotlinFactExtractor: LanguageFactExtractor = { language: "kotlin", extract: (input) => extractKotlinFacts(input) };

export const jvmSemanticAdapter: LanguageSemanticAdapter = {
  adapterId: "jvm-phase14b",
  adapterVersion: 1,
  languages: ["java", "kotlin"],
  capabilities: (language) => language === "java" ? JAVA_CAPABILITIES : KOTLIN_CAPABILITIES,
  normalizeFile: (facts, context) => normalizeJvmFacts(facts, context),
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-language-jvm.test.ts`

Expected: PASS for Java/Kotlin parser, codec, semantic-floor, ambiguity, unknown, unsupported, and deterministic fixtures.

- [ ] **Step 5: Commit**

```bash
git add src/core/facts/extractors/java.ts src/core/facts/extractors/kotlin.ts src/core/graph/resolver/adapters/jvm.ts test/fixtures/phase14b/java/expected.json test/fixtures/phase14b/kotlin/expected.json test/phase14b-language-jvm.test.ts
git commit -m "feat(resolver): enable Java and Kotlin semantic floors"
```

### Task 3.5: Implement Go floor

**Files:**
- Create: `src/core/facts/extractors/go.ts`
- Create: `src/core/graph/resolver/adapters/go.ts`
- Create: `test/fixtures/phase14b/go/expected.json`
- Create: `test/phase14b-language-go.test.ts`

**Interfaces:** Exports `goFactExtractor` and `goSemanticAdapter` using `tree-sitter-go@0.25.0`; owns `extractGoFacts(input: LanguageFactExtractorInput): FactExtractionOutcome` and `normalizeGoFacts(facts: ParsedFactsBlob, context: AdapterContext): SemanticEvidenceBatch`; covers packages, imports, receivers, interfaces, method sets, direct calls, and explicit uncertainty for interface dispatch.

- [ ] **Step 1: Write the failing test**
```ts
test("Go resolves a concrete receiver and preserves interface uncertainty", async () => {
  const result = await runLanguageFixture("go", { extractors: [goFactExtractor], adapter: goSemanticAdapter });
  assert.equal(result.decisions.find((item) => item.site === "go-concrete-receiver")?.status, "resolved");
  assert.equal(result.decisions.find((item) => item.site === "go-interface-set")?.status, "ambiguous");
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `node --import tsx/esm --test test/phase14b-language-go.test.ts`
Expected: FAIL because Go is not parser-enabled or extracted.
- [ ] **Step 3: Implement Go receiver extraction**
Persist receiver and interface method-set facts; resolve only fully observed concrete receiver ownership and never invoke the Go compiler.
```ts
export const goSemanticAdapter: LanguageSemanticAdapter = {
  adapterId: "go-phase14b", adapterVersion: 1, languages: ["go"],
  capabilities: () => GO_CAPABILITIES,
  normalizeFile: (facts, context) => normalizeGoFacts(facts, context),
};
export const goFactExtractor: LanguageFactExtractor = { language: "go", extract: extractGoFacts };
```
- [ ] **Step 4: Run test to verify it passes**
Run: `node --import tsx/esm --test test/phase14b-language-go.test.ts`
Expected: PASS for Go floor, ambiguity, unknown, budget, and deterministic output.
- [ ] **Step 5: Commit**
```bash
git add src/core/facts/extractors/go.ts src/core/graph/resolver/adapters/go.ts test/fixtures/phase14b/go/expected.json test/phase14b-language-go.test.ts
git commit -m "feat(resolver): enable Go semantic floor"
```

### Task 3.6: Implement Rust floor

**Files:**
- Create: `src/core/facts/extractors/rust.ts`
- Create: `src/core/graph/resolver/adapters/rust.ts`
- Create: `test/fixtures/phase14b/rust/expected.json`
- Create: `test/phase14b-language-rust.test.ts`

**Interfaces:** Exports `rustFactExtractor` and `rustSemanticAdapter` using `tree-sitter-rust@0.24.0`; owns `extractRustFacts(input: LanguageFactExtractorInput): FactExtractionOutcome` and `normalizeRustFacts(facts: ParsedFactsBlob, context: AdapterContext): SemanticEvidenceBatch`; covers modules, use aliases, structs, enums, impl/trait ownership, associated functions, and `let` assignments.

- [ ] **Step 1: Write the failing test**
```ts
test("Rust preserves generic trait dispatch uncertainty", async () => {
  const result = await runLanguageFixture("rust", { extractors: [rustFactExtractor], adapter: rustSemanticAdapter });
  assert.equal(result.decisions.find((item) => item.site === "rust-generic-trait")?.status, "unknown");
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `node --import tsx/esm --test test/phase14b-language-rust.test.ts`
Expected: FAIL because Rust is not parser-enabled or extracted.
- [ ] **Step 3: Implement Rust impl and trait extraction**
Persist explicit impl/trait ownership; leave generic, deref, macro, and trait dispatch uncertain.
```ts
export const rustSemanticAdapter: LanguageSemanticAdapter = {
  adapterId: "rust-phase14b", adapterVersion: 1, languages: ["rust"],
  capabilities: () => RUST_CAPABILITIES,
  normalizeFile: (facts, context) => normalizeRustFacts(facts, context),
};
export const rustFactExtractor: LanguageFactExtractor = { language: "rust", extract: extractRustFacts };
```
- [ ] **Step 4: Run test to verify it passes**
Run: `node --import tsx/esm --test test/phase14b-language-rust.test.ts`
Expected: PASS for Rust floor, uncertainty boundaries, budgets, and deterministic output.
- [ ] **Step 5: Commit**
```bash
git add src/core/facts/extractors/rust.ts src/core/graph/resolver/adapters/rust.ts test/fixtures/phase14b/rust/expected.json test/phase14b-language-rust.test.ts
git commit -m "feat(resolver): enable Rust semantic floor"
```

### Task 3.7: Implement Swift floor

**Files:**
- Create: `src/core/facts/extractors/swift.ts`
- Create: `src/core/graph/resolver/adapters/swift.ts`
- Create: `test/fixtures/phase14b/swift/expected.json`
- Create: `test/phase14b-language-swift.test.ts`

**Interfaces:** Exports `swiftFactExtractor` and `swiftSemanticAdapter` using `tree-sitter-swift@0.7.1`; owns `extractSwiftFacts(input: LanguageFactExtractorInput): FactExtractionOutcome` and `normalizeSwiftFacts(facts: ParsedFactsBlob, context: AdapterContext): SemanticEvidenceBatch`; covers imports, classes, structs, enums, protocols, extensions, initializers, and methods.

- [ ] **Step 1: Write the failing test**
```ts
test("Swift resolves explicit extension ownership", async () => {
  const result = await runLanguageFixture("swift", { extractors: [swiftFactExtractor], adapter: swiftSemanticAdapter });
  assert.equal(result.decisions.find((item) => item.site === "swift-extension-owner")?.status, "resolved");
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `node --import tsx/esm --test test/phase14b-language-swift.test.ts`
Expected: FAIL because Swift is not parser-enabled or extracted.
- [ ] **Step 3: Implement Swift ownership extraction**
Record an extension owner only when statically explicit; preserve protocol witness and overload uncertainty.
```ts
export const swiftSemanticAdapter: LanguageSemanticAdapter = {
  adapterId: "swift-phase14b", adapterVersion: 1, languages: ["swift"],
  capabilities: () => SWIFT_CAPABILITIES,
  normalizeFile: (facts, context) => normalizeSwiftFacts(facts, context),
};
export const swiftFactExtractor: LanguageFactExtractor = { language: "swift", extract: extractSwiftFacts };
```
- [ ] **Step 4: Run test to verify it passes**
Run: `node --import tsx/esm --test test/phase14b-language-swift.test.ts`
Expected: PASS for Swift floor, ambiguity, unsupported behavior, and deterministic output.
- [ ] **Step 5: Commit**
```bash
git add src/core/facts/extractors/swift.ts src/core/graph/resolver/adapters/swift.ts test/fixtures/phase14b/swift/expected.json test/phase14b-language-swift.test.ts
git commit -m "feat(resolver): enable Swift semantic floor"
```

### Task 3.8: Implement Dart floor

**Files:**
- Create: `src/core/facts/extractors/dart.ts`
- Create: `src/core/graph/resolver/adapters/dart.ts`
- Create: `test/fixtures/phase14b/dart/expected.json`
- Create: `test/phase14b-language-dart.test.ts`

**Interfaces:** Exports `dartFactExtractor` and `dartSemanticAdapter` using exact package identity `@driftlog/tree-sitter-dart@1.0.4`; owns `extractDartFacts(input: LanguageFactExtractorInput): FactExtractionOutcome` and `normalizeDartFacts(facts: ParsedFactsBlob, context: AdapterContext): SemanticEvidenceBatch`; covers imports, classes, constructors, extends/implements, mixins, extensions, receivers, and assignments.

- [ ] **Step 1: Write the failing test**
```ts
test("Dart preserves mixin selection ambiguity", async () => {
  const result = await runLanguageFixture("dart", { extractors: [dartFactExtractor], adapter: dartSemanticAdapter });
  assert.equal(result.decisions.find((item) => item.site === "dart-mixin-selection")?.status, "ambiguous");
});
```
- [ ] **Step 2: Run test to verify it fails**
Run: `node --import tsx/esm --test test/phase14b-language-dart.test.ts`
Expected: FAIL because Dart is not parser-enabled or extracted.
- [ ] **Step 3: Implement Dart ownership extraction**
Record mixin and extension relations; resolve only direct explicit ownership and exclude Flutter framework semantics.
```ts
export const dartSemanticAdapter: LanguageSemanticAdapter = {
  adapterId: "dart-phase14b", adapterVersion: 1, languages: ["dart"],
  capabilities: () => DART_CAPABILITIES,
  normalizeFile: (facts, context) => normalizeDartFacts(facts, context),
};
export const dartFactExtractor: LanguageFactExtractor = { language: "dart", extract: extractDartFacts };
```
- [ ] **Step 4: Run test to verify it passes**
Run: `node --import tsx/esm --test test/phase14b-language-dart.test.ts`
Expected: PASS for Dart floor, ambiguity, unsupported dynamic behavior, and deterministic output.
- [ ] **Step 5: Commit**
```bash
git add src/core/facts/extractors/dart.ts src/core/graph/resolver/adapters/dart.ts test/fixtures/phase14b/dart/expected.json test/phase14b-language-dart.test.ts
git commit -m "feat(resolver): enable Dart semantic floor"
```

### Task 3.9: Implement C family floors

**Files:**
- Create: `src/core/facts/extractors/c.ts`
- Create: `src/core/facts/extractors/cpp.ts`
- Create: `src/core/graph/resolver/adapters/c-family.ts`
- Create: `test/fixtures/phase14b/c/expected.json`
- Create: `test/fixtures/phase14b/cpp/expected.json`
- Create: `test/phase14b-language-c-family.test.ts`

**Interfaces:**
- Exports `cFactExtractor`, `cppFactExtractor`, and `cFamilySemanticAdapter` using `tree-sitter-c@0.24.1` and `tree-sitter-cpp@0.23.4`.
- Owns `extractCFacts(input: LanguageFactExtractorInput): FactExtractionOutcome`, `extractCppFacts(input: LanguageFactExtractorInput): FactExtractionOutcome`, and `normalizeCFamilyFacts(facts: ParsedFactsBlob, context: AdapterContext): SemanticEvidenceBatch`.
- Covers C functions/direct calls/variables/typedefs/structs/includes/aliases and exact function-pointer assignments; C++ namespaces/classes/structs/methods/constructors/inheritance/direct members/basic aliases.

- [ ] **Step 1: Write the failing test**

```ts
test("C family resolves direct structural ownership and rejects speculative dispatch", async () => {
  const result = await runLanguageFixture("c-family", { extractors: [cFactExtractor, cppFactExtractor], adapter: cFamilySemanticAdapter });
  assert.equal(result.decisions.find((item) => item.site === "c-direct-call")?.status, "resolved");
  assert.equal(result.decisions.find((item) => item.site === "c-pointer-ambiguous")?.status, "ambiguous");
  assert.equal(result.decisions.find((item) => item.site === "cpp-template")?.status, "unsupported");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-language-c-family.test.ts`

Expected: FAIL because C/C++ are not scanned, registered, or extracted.

- [ ] **Step 3: Implement structural C/C++ extraction**

Use exact declaration/assignment evidence for C function pointers. Keep C++ templates, overload resolution, ADL, SFINAE, concepts, and preprocessor-dependent semantics explicitly unsupported or unknown. Do not invoke clang.

```ts
export const cFamilySemanticAdapter: LanguageSemanticAdapter = {
  adapterId: "c-family-phase14b",
  adapterVersion: 1,
  languages: ["c", "cpp"],
  capabilities: (language) => language === "c" ? C_CAPABILITIES : CPP_CAPABILITIES,
  normalizeFile: (facts, context) => normalizeCFamilyFacts(facts, context),
};
export const cFactExtractor: LanguageFactExtractor = { language: "c", extract: extractCFacts };
export const cppFactExtractor: LanguageFactExtractor = { language: "cpp", extract: extractCppFacts };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-language-c-family.test.ts`

Expected: PASS for C/C++ parser, facts, adapter, floor, ambiguity, unsupported, budget, and deterministic fixtures.

- [ ] **Step 5: Commit**

```bash
git add src/core/facts/extractors/c.ts src/core/facts/extractors/cpp.ts src/core/graph/resolver/adapters/c-family.ts test/fixtures/phase14b/c/expected.json test/fixtures/phase14b/cpp/expected.json test/phase14b-language-c-family.test.ts
git commit -m "feat(resolver): enable C and C++ semantic floors"
```

### Task 3.10: Register semantic adapters and enforce capability advertisement

**Files:**
- Modify: `src/core/facts/language-fact-extractor.ts`
- Modify: `src/core/repository/repository-files.ts` (owned integration change)
- Modify: `src/core/repository/repository-status.service.ts`
- Create: `src/core/graph/resolver/adapter-registry.ts`
- Create: `test/phase14b-language-capabilities.test.ts`

**Interfaces:**
- `getLanguageFactExtractor(language)` returns the exact singular extractor wrapper for every target language, including separate JavaScript/TypeScript/TSX wrappers.
- `getLanguageAdapter(filePath)` returns the parser adapter for every declared extension.
- `getSemanticAdapter(language)` reads a distinct semantic-adapter registry; parser `registry.ts` remains owned by Task 3.1.
- `capabilities(language)` returns explicit per-capability `full`, `partial`, `unsupported`, or `not-applicable` values.
- Status does not report a language as supported until its fixture floor is green.
- Test-local `TARGET_LANGUAGES` and `getPhase14bCapabilities(): Record<string, Phase14bCapability>` are declared in `test/phase14b-language-capabilities.test.ts`.

- [ ] **Step 1: Write the failing test**

```ts
test("capability status advertises only languages that pass the semantic floor", () => {
  const capabilities = getPhase14bCapabilities();
  for (const language of TARGET_LANGUAGES) {
    assert.equal(capabilities[language].floorPassed, true, language);
    assert.ok(Object.values(capabilities[language].levels).every((level) => ["full", "partial", "unsupported", "not-applicable"].includes(level)));
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-language-capabilities.test.ts`

Expected: FAIL because the repository has no aggregate Phase14B language capability registry.

- [ ] **Step 3: Wire all adapters and capability profiles**

Register every family module once, classify all required extensions, connect parser metadata to fact extraction, and expose truthful capability levels. Keep unsupported constructs inside the language profile rather than downgrading unrelated repository capabilities. Do not modify the parser registry; the semantic registry is a separate owner boundary.

```ts
const semanticAdapters = [ecmascriptSemanticAdapter, pythonSemanticAdapter, jvmSemanticAdapter, goSemanticAdapter, rustSemanticAdapter, swiftSemanticAdapter, dartSemanticAdapter, cFamilySemanticAdapter] as const;
const semanticAdapterByLanguage = new Map(
  semanticAdapters.flatMap((adapter) => adapter.languages.map((language) => [language, adapter] as const)),
);

export function getSemanticAdapter(language: LanguageId): LanguageSemanticAdapter | undefined {
  return semanticAdapterByLanguage.get(language);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-language-capabilities.test.ts test/phase14b-parser-packaging.test.ts test/phase14b-language-*.test.ts`

Expected: PASS for all eleven languages and every applicable floor.

- [ ] **Step 5: Commit**

```bash
git add src/core/facts/language-fact-extractor.ts src/core/repository/repository-files.ts src/core/repository/repository-status.service.ts src/core/graph/resolver/adapter-registry.ts test/phase14b-language-capabilities.test.ts
git commit -m "feat(index): publish truthful language capabilities"
```

## Track checkpoint

Track 14B-3 is complete only when every target language has scanner, grammar, parser registry, objective extractor, codec round trip, semantic adapter, capability profile, floor fixtures, ambiguity/unknown/budget fixtures, deterministic repeated output, and no source-side semantic fallback. Family tasks may run in parallel after Task 3.1 and Track 14B-1/2; Task 3.10 is the serialized semantic integration gate. Go, Rust, Swift, and Dart remain independent executable/reviewable tasks.
