# Task 3.5 report

## Implemented

- Added the native tree-sitter Go fact extractor and semantic adapter.
- Extracts package/import facts, concrete and pointer receivers, interfaces, method-set ownership, constructors, parameters, and selector calls from the parsed Go AST.
- Resolves only an observed concrete receiver owner. Observed interface dispatch with multiple method-set owners is returned as `ambiguous`; partial parses and unobserved dispatch remain explicit uncertainty.
- No Go compiler/runtime, regex semantics, source reparse, or source-semantic fallback was added.

## Validation

- `node --import tsx/esm --test test/phase14b-language-go.test.ts` — 4/4 passed.
- `npx tsc --noEmit` — passed.
- `git diff --check` — passed.

## Impact note

GitNexus was invoked against the indexed `code-atlas` repository for the existing fact/resolver contract symbols before editing. The index does not contain the Phase 14B symbols in this worktree, so those targets returned `Target not found` with `UNKNOWN` risk. That result was treated as incomplete evidence; current source contracts and the focused tests were used for the implementation boundary.

## Loop round 1 fixes

- Receiver ownership now retains every observed method, including multiple methods on one receiver type, and emits implementation evidence for each matching interface method.
- Receiver parameters are marked during the receiver pass so recursive AST traversal cannot create duplicate named receiver bindings.
- The Go fixture helper now loads `test/fixtures/phase14b/go/main.go` and its expected site data; concrete call sites are resolved through `runLanguageFixture`.
- Tests assert resolver call decisions (`calls` edge kind), zero candidate budget exhaustion, cold/warm memo reuse, deterministic facts/decisions, fixture content hashing, and no source semantic fallback.
- Go symbols and type evidence use package-qualified names, while imported type references retain import module qualification instead of global-name lookup.

## Loop round 1 validation

- `node --import tsx/esm --test test/phase14b-language-go.test.ts` — 4/4 passed.
- `node --import tsx/esm --test test/phase14b-language-*.test.ts test/phase14b-parser-packaging.test.ts test/phase14b-facts-contract.test.ts` — 33/33 passed.
- `npx tsc --noEmit` — passed.
- `git diff --check` — passed.
