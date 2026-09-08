# Task 3.7 report: Swift semantic floor

## Result

Swift AST extraction and semantic normalization are present for imports, classes,
structs, enums, protocols, explicitly named extensions, initializers, methods,
properties, constructors, and member calls. Extension ownership is emitted only
when the owner is statically named and found in the AST. Protocol witness and
overload dispatch remain explicit diagnostics/uncertainty; no compiler or
runtime semantics are guessed.

The implementation uses the existing native `tree-sitter` parser runtime and
`tree-sitter-swift@0.7.1`. It does not add packages or registry integration,
reparse source, use regex semantics, or use a compiler/runtime/source fallback.

## Verification

- `node --import tsx/esm --test test/phase14b-language-swift.test.ts test/phase14b-facts-contract.test.ts test/phase14b-resolver-contract.test.ts` — 11/11 passed.
- `CI=true pnpm exec tsc --noEmit` — passed.
- `git diff --check` — passed.

- GitNexus `impact` was attempted for the Swift symbols, but the available index
  is stale and belongs to another worktree/branch; both lookups returned
  `Target not found`, so no definitive blast-radius claim is made.
- `detect_changes` is run before commit as required; the stale-index limitation
  is recorded here if it remains in the output.

## Scope

Changed only the Swift adapter constraint normalization and this report after
the existing Task 3.7 implementation commit. No package, registry, or unrelated
worktree changes were made.

## Follow-up review

The follow-up closes the independent-review gaps without changing shared
package or registry surfaces: Swift capabilities now report partial coverage
where compiler-grade resolution is unavailable; extension ownership is
unique-or-drop; AST-derived overload and protocol-witness uncertainty is
diagnosed explicitly; local constructor bindings preserve resolver controls;
and the fixture asserts struct scope identity, warm memo reuse, and budget
exhaustion.

Follow-up validation: `node --import tsx/esm --test test/phase14b-language-swift.test.ts test/phase14b-language-jvm.test.ts test/phase14b-language-go.test.ts test/phase14b-language-rust.test.ts test/phase14b-language-python.test.ts test/phase14b-language-ecmascript.test.ts test/phase14b-facts-contract.test.ts test/phase14b-resolver-contract.test.ts` — 46/46 passed.

## Extension-order follow-up

Swift extension ownership is now resolved after an AST-only declaration pre-scan,
so a uniquely named owner is found regardless of traversal order while duplicate
owners remain dropped. The fixture covers extension-before-owner resolution and
duplicate-owner ambiguity.

- `node --import tsx/esm --test test/phase14b-language-swift.test.ts` — 6/6 passed.
- Cross-language focused test command above — 46/46 passed.
- `CI=true pnpm exec tsc --noEmit` — passed.
- `git diff --check` — passed.

## Scope-order follow-up

Deferred Swift extensions now reuse the scope created during the initial AST
traversal, preserving its original parent path and emitting exactly one scope
per extension node. The regression fixture asserts one extension scope with a
source-file parent while preserving unique ownership and duplicate-owner drop.

- `node --import tsx/esm --test test/phase14b-language-swift.test.ts` — 6/6 passed.
- Cross-language focused test command above — 46/46 passed.
- `CI=true pnpm exec tsc --noEmit` — passed.
- `git diff --check` — passed.
