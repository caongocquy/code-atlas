# Track 14B-3 Task 3.2 report

- Implemented the ECMAScript objective fact extractor in `src/core/facts/extractors/ecmascript.ts`.
- Added exact `javascript`, `typescript`, and `tsx` extractor wrappers.
- Added `ecmascriptSemanticAdapter` and `normalizeEcmascriptFacts` in `src/core/graph/resolver/adapters/ecmascript.ts`.
- Covered bindings/scopes, imports/exports, calls, constructors, assignments and aliases, parameters, returns, receiver/member facts, declared types, interfaces, implements, type aliases, modules, and parser diagnostics/status.
- Reused one `parseSource` call per extraction; semantic extraction uses Tree-sitter nodes and does not reparse or use source-text regex semantics.
- JSX parse status and parser diagnostics remain represented in `ParsedFactsBlob`.
- Added the ECMAScript fixture expectation and focused tests, including typed construction/member resolution and exact wrapper identity.

Validation:

- `CI=1 pnpm exec tsc --noEmit` — pass.
- `node --import tsx/esm --test test/phase14b-language-ecmascript.test.ts test/phase14b-facts-contract.test.ts` — 7/7 pass.
- `git diff --check` — pass.
- GitNexus impact was run before edits; the shared index was stale and associated with another worktree/branch, so impact evidence was treated as non-authoritative for new Task 3.2 symbols.
