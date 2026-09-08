# Track 14B-3 Task 3.3 report

- Implemented `pythonFactExtractor` with one `parseSource` call and Tree-sitter Python AST node/field traversal only.
- Covered Python imports and aliases, classes and base classes, `self` members, assignments and aliases, annotations, parameters, returns, constructors, direct calls, and module facts.
- Implemented `pythonSemanticAdapter` / `normalizePythonFacts` with declared binding/type and class-member ownership evidence.
- Dynamic attribute receivers remain unresolved (`unknown`); runtime/compiler-dependent calls (`eval`, `exec`, `compile`, `__import__`, `setattr`, `delattr`, `globals`, `locals`) emit `compiler_semantics_required` (`unsupported` at resolver decision time).
- Partial Tree-sitter parses emit `parse_uncertain` and `language_capability_unsupported`; no runtime execution, source regex, or semantic reparse is used.
- Added the Python fixture expectation and focused tests for fact coverage, typed `self` member resolution, dynamic uncertainty, and runtime unsupported diagnostics.
- Package and parser registry files were not modified.

Validation:

- `node --import tsx/esm --test test/phase14b-language-python.test.ts` — 3/3 pass.
- `./node_modules/.bin/tsc --noEmit` — pass.
- `node --import tsx/esm --test test/phase14b-language-python.test.ts test/phase14b-facts-contract.test.ts test/phase14b-no-source-side-channel.test.ts` — 9/9 pass.
- `git diff --check` — pass.
- GitNexus impact was attempted before edits but could not open a worktree-local database; CodeAtlas inspect-change was run and found only the four Task 3.3 files, with incomplete legacy-index evidence.
- The requested `detect_changes()` operation was unavailable in the exposed MCP/CLI environment; the available staged inspect/change-gate checks were used instead.

## Fix loop round 1

- Class-scope annotation-only members now create class-owned variable symbols; `self.attribute` annotations and assignments reuse the same member symbol and retain their declared type/assignment facts.
- Top-level Python function declarations now create lexical function bindings with AST-range ownership, allowing direct calls to resolve while duplicate declarations remain ambiguous.
- Added focused assertions for direct-call resolution, duplicate-call ambiguity, zero-budget exhaustion, repeated extraction determinism, cold/warm fixture equivalence, and class/member ownership.
- Runtime introspection now includes `getattr` and remains explicit `compiler_semantics_required`; dynamic receivers remain unknown.
- Preserved one `parseSource` call, AST-only semantics, and no package/registry changes.

Fix-loop validation:

- `./node_modules/.bin/tsc --noEmit` — pass.
- `node --import tsx/esm --test test/phase14b-language-python.test.ts test/phase14b-facts-contract.test.ts test/phase14b-no-source-side-channel.test.ts test/phase14b-resolver-decisions.test.ts test/phase14b-resolver-determinism.test.ts` — 21/21 pass.
- `git diff --check` — pass.
