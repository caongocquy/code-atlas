# Phase 14B-3 Language Enablement Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Enable all eleven target language families through scanner, parser, objective extraction, semantic adapter, capability profile, and conformance fixtures.

**Architecture:** Keep one native `tree-sitter@0.25.1` parser runtime and register one grammar adapter per language. Family helpers may normalize shared concepts, but each language owns grammar node mapping and conservative unsupported behavior. Package integration is single-owner; family modules can be developed independently after the shared facts/resolver contracts land.

**Tech Stack:** Node 22, TypeScript 7.0.2, pnpm 11.22.0, native Tree-sitter Node bindings, pinned grammar packages, `node:test` fixtures under `test/fixtures/phase14b/`.

**Spec:** [Phase14B revised design](<HOME>/code-atlas/docs/superpowers/specs/2026-09-07-phase14b-multilanguage-resolver-typeenvironment-v2-design-revised.md), §§1, 5, 6, 18–20, 35, 37–38, 42–44.

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

### Task 3.1: Validate and integrate native grammar packages

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/core/graph/parsers/types.ts`
- Modify: `src/core/graph/parsers/languages.ts`
- Modify: `src/core/graph/parsers/registry.ts`
- Modify: `src/core/graph/parsers/code-parser.ts`
- Test: `test/phase14b-parser-packaging.test.ts`

**Interfaces:**
- `SupportedLanguage` includes `typescript`, `tsx`, `javascript`, `python`, `java`, `kotlin`, `go`, `rust`, `swift`, `dart`, `c`, and `cpp`.
- `getLanguageAdapter(filePath: string): LanguageAdapter | null`, `getLanguageConfig(filePath: string): LanguageConfig | null`, and `parseSource(source: string, filePath: string): ParsedSource | undefined` remain the parser entry points.
- Each adapter exposes `metadata` with exact package grammar/version and `extensions` for `.js/.jsx/.ts/.tsx/.py/.java/.kt/.kts/.go/.rs/.swift/.dart/.c/.h/.cc/.cpp/.cxx/.hpp`.
- Creates `test/helpers/phase14b-language-fixtures.ts` with `parserFixtures`, `targetLanguages`, `type LanguageFixtureResult`, and `runLanguageFixture(name: string, options?: { memoMode?: "cold" | "warm"; parallel?: boolean }): Promise<LanguageFixtureResult>`; family tests use these exact helpers.

- [ ] **Step 1: Write the failing test**

```ts
test("all target grammars load through the native parser runtime", () => {
  for (const fixture of parserFixtures) {
    const parsed = parseSource(fixture.source, fixture.filePath);
    assert.ok(parsed, fixture.filePath);
    assert.equal(parsed.adapter.language, fixture.language);
    assert.equal(parsed.tree.rootNode.hasError, false, fixture.filePath);
  }
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-parser-packaging.test.ts`

Expected: FAIL because only JS/TS/TSX grammars are installed and registered.

- [ ] **Step 3: Add exact native dependencies and registry entries**

Add the nine pinned packages listed above. Confirm their package metadata, native binding loading, Node 22 engine behavior, and `npm pack --dry-run` inclusion. Do not add postinstall scripts. Keep a single `Parser` instance creation path and record package versions in `parserMetadata`.

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm install --frozen-lockfile && node --import tsx/esm --test test/phase14b-parser-packaging.test.ts`

Expected: PASS for all grammar fixtures and package metadata. If a native grammar cannot load on the current Node/platform, stop with the exact package/ABI error.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml src/core/graph/parsers/types.ts src/core/graph/parsers/languages.ts src/core/graph/parsers/registry.ts src/core/graph/parsers/code-parser.ts test/phase14b-parser-packaging.test.ts
git commit -m "feat(parser): register Phase 14B language grammars"
```

### Task 3.2: Implement ECMAScript facts and adapter floor

**Files:**
- Create: `src/core/facts/extractors/ecmascript.ts`
- Create: `src/core/graph/resolver/adapters/ecmascript.ts`
- Create: `test/fixtures/phase14b/ecmascript/expected.json`
- Create: `test/phase14b-language-ecmascript.test.ts`

**Interfaces:**
- Exports `ecmascriptFactExtractor` as a `LanguageFactExtractor` for JavaScript, TypeScript, and TSX.
- Exports `ecmascriptSemanticAdapter` as a `LanguageSemanticAdapter` for those three IDs.
- Covers lexical bindings/shadowing, imports/exports, direct calls, constructors, assignments, parameters, returns, receiver/member chains, aliases, declared types, interfaces, implements, type aliases, and JSX-preserving parse status.

- [ ] **Step 1: Write the failing test**

```ts
test("ECMAScript floor resolves typed construction and member calls without name guesses", async () => {
  const result = await runLanguageFixture("ecmascript");
  assert.deepEqual(result.decisions.map((decision) => decision.status), ["resolved"]);
  assert.equal(result.decisions[0]?.confidence, "strong");
  assert.equal(result.usedSourceSemanticFallback, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-language-ecmascript.test.ts`

Expected: FAIL because the current extractor has no objective assignment/member/parameter/return facts and no semantic adapter.

- [ ] **Step 3: Implement grammar-specific extraction and normalization**

Map Tree-sitter node fields into the Task 1.1 facts, then normalize them into Task 2.1 evidence. Preserve JSX as syntax while keeping TypeScript type evidence explicit. Emit `unknown` for dynamic property access and preserve ambiguous overload-like candidates.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-language-ecmascript.test.ts test/phase14b-facts-contract.test.ts`

Expected: PASS for JS, TS, TSX floor fixtures, ambiguity, unknown dynamic access, and deterministic fact codec output.

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
- Covers imports, aliases, classes, `self` members, assignments, annotations, parameters, returns, constructors, direct calls, and explicit unsupported dynamic/runtime cases.

- [ ] **Step 1: Write the failing test**

```ts
test("Python floor resolves annotation-backed self member and preserves dynamic uncertainty", async () => {
  const result = await runLanguageFixture("python");
  assert.equal(result.decisions.find((item) => item.site === "typed-member")?.status, "resolved");
  assert.equal(result.decisions.find((item) => item.site === "dynamic-member")?.status, "unknown");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-language-python.test.ts`

Expected: FAIL because Python has no extractor, registry adapter, or facts support.

- [ ] **Step 3: Implement Python extractor and adapter**

Use Python AST node fields only; do not execute Python or infer runtime monkey-patching. Mark runtime-dependent dispatch unsupported/unknown and retain annotation/class/import evidence.

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
- Covers packages/imports, classes/interfaces, extends/implements, constructors/primary constructors, fields/members, parameters/returns, nullable types, Kotlin objects/companions, typealiases, and conservative extension/overload outcomes.

- [ ] **Step 1: Write the failing test**

```ts
test("JVM floor resolves declared member ownership and does not guess Kotlin overloads", async () => {
  const result = await runLanguageFixture("jvm");
  assert.equal(result.decisions.find((item) => item.site === "java-member")?.status, "resolved");
  assert.equal(result.decisions.find((item) => item.site === "kotlin-overload")?.status, "ambiguous");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-language-jvm.test.ts`

Expected: FAIL because Java/Kotlin are not registered or extracted.

- [ ] **Step 3: Implement separate grammar mappings behind shared JVM evidence helpers**

Keep Java and Kotlin parser queries separate. Normalize only shared package/import/type/member facts. Treat extension functions, overload selection without enough declared information, and compiler-only dispatch as explicit uncertainty.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-language-jvm.test.ts`

Expected: PASS for Java/Kotlin parser, codec, semantic-floor, ambiguity, unknown, unsupported, and deterministic fixtures.

- [ ] **Step 5: Commit**

```bash
git add src/core/facts/extractors/java.ts src/core/facts/extractors/kotlin.ts src/core/graph/resolver/adapters/jvm.ts test/fixtures/phase14b/java/expected.json test/fixtures/phase14b/kotlin/expected.json test/phase14b-language-jvm.test.ts
git commit -m "feat(resolver): enable Java and Kotlin semantic floors"
```

### Task 3.5: Implement Go and Rust floors

**Files:**
- Create: `src/core/facts/extractors/go.ts`
- Create: `src/core/facts/extractors/rust.ts`
- Create: `src/core/graph/resolver/adapters/go.ts`
- Create: `src/core/graph/resolver/adapters/rust.ts`
- Create: `test/fixtures/phase14b/go/expected.json`
- Create: `test/fixtures/phase14b/rust/expected.json`
- Create: `test/phase14b-language-go-rust.test.ts`

**Interfaces:**
- Exports `goFactExtractor`, `rustFactExtractor`, `goSemanticAdapter`, and `rustSemanticAdapter` using `tree-sitter-go@0.25.0` and `tree-sitter-rust@0.24.0`.
- Covers Go packages/imports/receivers/interfaces/method sets and Rust modules/use/structs/enums/impl/traits/associated functions/let/aliases.

- [ ] **Step 1: Write the failing test**

```ts
test("Go and Rust resolve concrete ownership while preserving interface/trait uncertainty", async () => {
  const result = await runLanguageFixture("go-rust");
  assert.equal(result.decisions.find((item) => item.site === "go-concrete-receiver")?.status, "resolved");
  assert.equal(result.decisions.find((item) => item.site === "go-interface-set")?.status, "ambiguous");
  assert.equal(result.decisions.find((item) => item.site === "rust-generic-trait")?.status, "unknown");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-language-go-rust.test.ts`

Expected: FAIL because neither language has a parser or extractor.

- [ ] **Step 3: Implement concrete receiver/impl extraction**

Persist Go receiver and interface method-set facts; resolve only fully observed concrete receiver ownership. Persist Rust impl/trait ownership; leave generic, deref, macro, and trait dispatch uncertain. No compiler invocation.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-language-go-rust.test.ts`

Expected: PASS for both floors, unsupported/unknown boundaries, budgets, and repeated deterministic output.

- [ ] **Step 5: Commit**

```bash
git add src/core/facts/extractors/go.ts src/core/facts/extractors/rust.ts src/core/graph/resolver/adapters/go.ts src/core/graph/resolver/adapters/rust.ts test/fixtures/phase14b/go/expected.json test/fixtures/phase14b/rust/expected.json test/phase14b-language-go-rust.test.ts
git commit -m "feat(resolver): enable Go and Rust semantic floors"
```

### Task 3.6: Implement Swift and Dart floors

**Files:**
- Create: `src/core/facts/extractors/swift.ts`
- Create: `src/core/facts/extractors/dart.ts`
- Create: `src/core/graph/resolver/adapters/swift.ts`
- Create: `src/core/graph/resolver/adapters/dart.ts`
- Create: `test/fixtures/phase14b/swift/expected.json`
- Create: `test/fixtures/phase14b/dart/expected.json`
- Create: `test/phase14b-language-swift-dart.test.ts`

**Interfaces:**
- Exports `swiftFactExtractor`, `dartFactExtractor`, `swiftSemanticAdapter`, and `dartSemanticAdapter` using `tree-sitter-swift@0.7.1` and `@driftlog/tree-sitter-dart@1.0.4`.
- Covers Swift imports/classes/structs/enums/protocols/extensions/initializers/methods and Dart imports/classes/constructors/extends/implements/mixins/extensions/receivers/assignments.

- [ ] **Step 1: Write the failing test**

```ts
test("Swift and Dart resolve direct ownership and preserve extension/mixin ambiguity", async () => {
  const result = await runLanguageFixture("swift-dart");
  assert.equal(result.decisions.find((item) => item.site === "swift-extension-owner")?.status, "resolved");
  assert.equal(result.decisions.find((item) => item.site === "dart-mixin-selection")?.status, "ambiguous");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --import tsx/esm --test test/phase14b-language-swift-dart.test.ts`

Expected: FAIL because Swift/Dart are not parser-enabled.

- [ ] **Step 3: Implement explicit ownership facts**

Record Swift extension owner only when statically explicit; preserve protocol witness and overload uncertainty. Record Dart mixin/extension relations and resolve only direct explicit ownership; exclude Flutter framework semantics.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-language-swift-dart.test.ts`

Expected: PASS for parser, facts, adapters, floors, ambiguity, unsupported dynamic behavior, and deterministic output.

- [ ] **Step 5: Commit**

```bash
git add src/core/facts/extractors/swift.ts src/core/facts/extractors/dart.ts src/core/graph/resolver/adapters/swift.ts src/core/graph/resolver/adapters/dart.ts test/fixtures/phase14b/swift/expected.json test/fixtures/phase14b/dart/expected.json test/phase14b-language-swift-dart.test.ts
git commit -m "feat(resolver): enable Swift and Dart semantic floors"
```

### Task 3.7: Implement C family floors

**Files:**
- Create: `src/core/facts/extractors/c.ts`
- Create: `src/core/facts/extractors/cpp.ts`
- Create: `src/core/graph/resolver/adapters/c-family.ts`
- Create: `test/fixtures/phase14b/c/expected.json`
- Create: `test/fixtures/phase14b/cpp/expected.json`
- Create: `test/phase14b-language-c-family.test.ts`

**Interfaces:**
- Exports `cFactExtractor`, `cppFactExtractor`, and `cFamilySemanticAdapter` using `tree-sitter-c@0.24.1` and `tree-sitter-cpp@0.23.4`.
- Covers C functions/direct calls/variables/typedefs/structs/includes/aliases and exact function-pointer assignments; C++ namespaces/classes/structs/methods/constructors/inheritance/direct members/basic aliases.

- [ ] **Step 1: Write the failing test**

```ts
test("C family resolves direct structural ownership and rejects speculative dispatch", async () => {
  const result = await runLanguageFixture("c-family");
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

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-language-c-family.test.ts`

Expected: PASS for C/C++ parser, facts, adapter, floor, ambiguity, unsupported, budget, and deterministic fixtures.

- [ ] **Step 5: Commit**

```bash
git add src/core/facts/extractors/c.ts src/core/facts/extractors/cpp.ts src/core/graph/resolver/adapters/c-family.ts test/fixtures/phase14b/c/expected.json test/fixtures/phase14b/cpp/expected.json test/phase14b-language-c-family.test.ts
git commit -m "feat(resolver): enable C and C++ semantic floors"
```

### Task 3.8: Register adapters and enforce capability advertisement

**Files:**
- Modify: `src/core/facts/language-fact-extractor.ts`
- Modify: `src/core/graph/parsers/registry.ts` (owned integration change)
- Modify: `src/core/repository/repository-files.ts` (owned integration change)
- Modify: `src/core/repository/repository-status.service.ts`
- Create: `test/phase14b-language-capabilities.test.ts`

**Interfaces:**
- `getLanguageFactExtractor(language)` returns the family extractor for every target language.
- `getLanguageAdapter(filePath)` returns the parser adapter for every declared extension.
- `capabilities(language)` returns explicit per-capability `full`, `partial`, `unsupported`, or `not-applicable` values.
- Status does not report a language as supported until its fixture floor is green.

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

Register every family module once, classify all required extensions, connect parser metadata to fact extraction, and expose truthful capability levels. Keep unsupported constructs inside the language profile rather than downgrading unrelated repository capabilities.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --import tsx/esm --test test/phase14b-language-capabilities.test.ts test/phase14b-parser-packaging.test.ts test/phase14b-language-*.test.ts`

Expected: PASS for all eleven languages and every applicable floor.

- [ ] **Step 5: Commit**

```bash
git add src/core/facts/language-fact-extractor.ts src/core/graph/parsers/registry.ts src/core/repository/repository-files.ts src/core/repository/repository-status.service.ts test/phase14b-language-capabilities.test.ts
git commit -m "feat(index): publish truthful language capabilities"
```

## Track checkpoint

Track 14B-3 is complete only when every target language has scanner, grammar, parser registry, objective extractor, codec round trip, semantic adapter, capability profile, floor fixtures, ambiguity/unknown/budget fixtures, deterministic repeated output, and no source-side semantic fallback. Family tasks may run in parallel after Task 3.1 and Track 14B-1/2; Task 3.8 is the serialized integration gate.
