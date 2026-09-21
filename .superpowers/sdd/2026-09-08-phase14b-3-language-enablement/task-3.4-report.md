# Task 3.4 report — JVM language semantic floors

Implemented separate Tree-sitter AST mappings for Java and Kotlin and a shared JVM-only semantic normalizer.

- Java: packages/imports, classes/interfaces, extends/implements, constructors, fields/members, parameters, return types, calls and assignments.
- Kotlin: packages/imports, classes/interfaces, inheritance/implementation, primary constructors, nullable types, properties/members, objects, companions, typealiases, parameters and returns.
- Kotlin extension functions emit explicit `extension_dispatch_unsupported` evidence.
- Repeated method names emit explicit overload ambiguity and compiler-dispatch uncertainty evidence; no compiler-only dispatch is guessed.
- No source regex semantic parsing, source reparse, registry/package changes, or persistence changes.

Validation:

- `node --import tsx/esm --test test/phase14b-*.test.ts`: 68/68 passing.
- `./node_modules/.bin/tsc --noEmit`: passing.
- `git diff --check`: passing.

## Loop round 3 — Kotlin overload resolution is explicitly ambiguous

- The Kotlin extractor now maps `navigation_suffix` to its AST `simple_identifier` (`run`) instead of preserving the grammar punctuation (`.run`), and reuses the enclosing call site identity for the member-call resolution site.
- JVM normalization infers a constructor-expression receiver such as `Overload()` from AST-derived facts and emits one member evidence record for each method overload in the enclosing Kotlin type. The resolver therefore receives two concrete candidates and returns `ambiguous`; the test asserts at least two candidates rather than only changing the expected status.
- Java/Kotlin grammar mappings, prior interface/capability/nullable fixes, shared JVM fixture state, and task scope remain unchanged.

Loop round 3 validation:

- `node --import tsx/esm --test test/phase14b-language-jvm.test.ts`: 8/8 passing.
- `node --import tsx/esm --test test/phase14b-*.test.ts`: 72/72 passing.
- `./node_modules/.bin/tsc --noEmit`: passing.
- `git diff --check`: passing.
- `gitnexus detect-changes --repo code-atlas --scope working --limit 100`: `No changes detected` from the stale available index.

## Loop round 2 — non-vacuous shared JVM fixture

- Added one `jvm` fixture containing the real Java and Kotlin source cases.
- The fixture derives concrete `ResolutionSiteIdentity` entries from extracted facts: a Java resolved member site plus Kotlin inheritance/extension/overload sites with expected `unknown` outcomes.
- `floorPassed` now requires a non-empty decision list whose statuses exactly match the fixture's expected outcomes; it cannot pass from `every(...)` over an empty list.
- Cold and warm runs reuse the same `LanguageFixtureResolverState` and memo. The test asserts identical decisions/facts/evidence, state identity, and `memoHitCount > 0`.

Loop round 2 validation:

- `node --import tsx/esm --test test/phase14b-language-jvm.test.ts`: 8/8 passing.
- `node --import tsx/esm --test test/phase14b-*.test.ts`: 72/72 passing.
- `./node_modules/.bin/tsc --noEmit`: passing.
- `git diff --check`: passing.
- `pnpm exec tsc --noEmit`: pnpm attempted a non-TTY modules purge and aborted with `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`; the checked-in compiler binary was used successfully instead.
- GitNexus impact was attempted for the existing resolver/parser/facts contracts, but the available index is stale and points at another branch; all queried targets returned `UNKNOWN`/not found.

## Loop round 1 — P1 fixes

- Kotlin interface detection now reads the grammar token child (`interface`) independently of preceding `modifiers`; public, sealed, and combined public-sealed interface cases are covered.
- JVM normalization retains nullable syntax as `TypeRef.named` (for example `String?`) instead of erasing `?`; the Kotlin fixture asserts nullable evidence.
- Java and Kotlin have separate exported capability profiles. Kotlin compiler-sensitive operations are partial rather than incorrectly full.
- Java/Kotlin parser fixtures now contain real source cases. `runLanguageFixture` loads them, checks exact parser identity, compares cold/warm repeated extraction and normalization, and asserts the required floor plus extension/overload/compiler uncertainty evidence.

Loop round 1 validation:

- `node --import tsx/esm --test test/phase14b-language-jvm.test.ts`: 8/8 passing.
- `node --import tsx/esm --test test/phase14b-*.test.ts`: 72/72 passing.
- `./node_modules/.bin/tsc --noEmit`: passing.
- `git diff --check`: passing.
