# Task 1.1 Report — Complete objective fact model

## Status

Implemented and committed on the task branch.

## Scope completed

- Added the eleven target language IDs plus `tsx` to the parser language ID union:
  TypeScript, TSX, JavaScript, Python, Java, Kotlin, Go, Rust, Swift, Dart, C,
  and C++.
- Defined the branded, path-neutral `FactLocalId`.
- Defined the tree-sitter `ParserIdentity` contract with runtime, package, and
  grammar identity fields.
- Added the complete objective fact DTO set for expressions, members,
  assignments, parameters, returns, constructors, inheritances,
  implementations, aliases, modules, and namespaces.
- Extended `ParsedFactsBlob` with deterministic arrays for every new DTO while
  retaining all Phase 14A arrays.
- Added reusable Phase 14B fixture helpers: `range`, `makeFacts`, and
  `expectation`.
- Updated the Phase 14A fact factory to provide empty Phase 14B arrays and
  updated its parser identity fixture for the new contract.
- Kept `FACTS_SCHEMA_VERSION` and `FACTS_VERSION` unchanged.

## TDD evidence

1. Added the contract test before the implementation.
2. Ran `node --import tsx/esm --test test/phase14b-facts-contract.test.ts`.
   It failed because the new helper/contract did not exist.
3. Added the minimal typed model and fixture helper.
4. Ran the focused suite:
   `node --import tsx/esm --test test/phase14b-facts-contract.test.ts test/phase14a-facts.test.ts`.
   Result: 11 tests passed, 0 failed.
5. Ran `git diff --check`; result was clean.

## Impact and concerns

- GitNexus impact analysis was attempted for `ParsedFactsBlob`,
  `ParserIdentity`, and `SupportedLanguage`. The indexed repository did not
  contain these type aliases, so GitNexus returned `UNKNOWN` with zero indexed
  impacted symbols. CodeGraph also reported that only the parent worktree was
  indexed; no reindex was performed.
- `facts-identity.ts`, `facts-codec.ts`, the fact extractor, and existing parser
  adapters still contain the pre-Task-1.1 runtime/cache metadata shape. They
  were intentionally not modified because they are outside the declared file
  list and are owned by subsequent migration work. Full repository typecheck
  was not used as a Task 1.1 gate for that reason.

## Commit

See the task commit recorded with this report.

## Loop round 1 compatibility fix

Independent review and the controller typecheck found that the initial type
contract was not wired through its existing producers and consumers. The fix
kept the change compatibility-only:

- Updated `facts-codec.ts` and `facts-identity.ts` to use
  `runtimeName`, `runtimeVersion`, `packageName`, `grammarName`, and
  `grammarVersion`.
- Updated the TypeScript and JavaScript parser adapters to emit the new
  metadata shape.
- Made parser filename lookup partial so the expanded language union does not
  claim unimplemented adapters.
- Widened pipeline language annotations to `SupportedLanguage`.
- Updated extractor local-ID construction for the branded `FactLocalId` and
  initialized every Phase 14B array with an empty deterministic array.
- Updated affected Phase 14A/14B cache, generation, race, and importer test
  fixtures to the complete fact shape.
- Added regression coverage for parser identity round-tripping and complete
  extraction output.

No semantic resolution was added. `FACTS_SCHEMA_VERSION` and `FACTS_VERSION`
were not changed.

Validation:

- `pnpm exec tsc --noEmit` — passed.
- Focused fact/cache suite — 30 passed, 0 failed.
- `pnpm test` — 318 passed, 0 failed.
- `git diff --check` — passed.

GitNexus impact checks for the changed fact symbols were unavailable in the
stale index (`UNKNOWN`, zero indexed targets); the indexed `runPipeline` path
reported LOW risk with four impacted symbols.

The compatibility fix is committed separately after the original Task 1.1
commit.
