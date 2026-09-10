# SDD ledger — plan: Phase 14C execution

Preflight: current base branch HEAD a5bf0f8; accepted production ancestor d463d02; worktree branch codex/phase14c-framework-dynamic-edges.

Ruling: use current fix/cli-index-progress-ux HEAD a5bf0f8 as implementation parent because it contains the canonical Phase 14C spec commits; d463d02 remains the production baseline for regression comparison.

Preflight scan (2026-09-10):
- Shared 0.1 -> 0.2: framework.types supplies facts imports; 0.2 adds ObjectiveSyntax only; no field collision.
- Shared 0.2 -> 0.3: facts version constants owned by 0.2; framework version owned by 0.3; no duplicate bump.
- Shared 0.3 -> 0.4: IndexVersionDomains is extended before schema metadata; schemaVersion remains persistence-only.
- Shared 0.4 -> 0.5: schema tables precede AtlasStore APIs; 0.5 uses existing candidate lifecycle and does not switch active generation.
- Shared 0.5 -> 1.3/6.1: storage read API is generation-scoped; publisher and query projection must use the same active generation.
- 1.1 -> 1.2: config facts are materialized before detection; adapters receive snapshots only.
- 1.2 -> 1.3: gate output is FrameworkMaterialization; publisher requires completed same-generation framework state.
- 1.4 -> 1.5: invalidation plan and counters feed the shared fixture; no framework version bump in adapter tracks.
- Tracks 2/3/4/5 -> 6: each emits only shared typed adapter output; no framework track imports another adapter.
- 6.4 -> 6.5: verification evidence precedes closure report; closure cannot waive a new failure.
- Each task self-consistency: listed tests exercise the produced interface; listed Modify paths are audited repository paths; Create paths are new.
Ruling: if plan snippets conflict with the canonical spec, preserve the spec and record the smallest interface correction in the task ledger.

Fix round 1 report (2026-09-10):
- Reviewer gaps addressed: canonical six-element logical tuple validation with exact JSON serialization and sorted unique conditions; separate `FrameworkInfrastructureFailure`/`FrameworkDiagnosticOutcome` support for `framework_adapter_failed`; output-kind-discriminated coverage; bounded accepted provenance (nonempty unique IDs/refs, 32-item cap, bounded strings, repository-relative paths, validated source ranges).
- RED: `rtk proxy node --import tsx/esm --test test/phase14c-contracts.test.ts` -> 11 tests, 9 passed, 2 failed (malformed logical keys and unbounded provenance).
- GREEN: `rtk proxy node --import tsx/esm --test test/phase14c-contracts.test.ts` -> 11 passed, 0 failed, 0 skipped.
- GREEN: `rtk proxy node_modules/.bin/tsc --noEmit` -> exit 0.
- GREEN: `rtk proxy node_modules/.bin/tsc --noEmit --ignoreConfig --strict --types node --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck test/phase14c-contracts.test.ts` -> exit 0.
- GREEN: targeted eslint for the four task files -> exit 0.
- No new ruling was required; no pipeline, storage, package, lockfile, or other test files were changed.

Fix round 2 report (2026-09-10):
- Reviewer gaps addressed: logical-key scope/router validation now rejects backslashes, dot segments, repeated separators, and other noncanonical relative paths without normalization; accepted provenance rejects unknown fields, enforces bounded serialized source ranges/evidence refs/provenance arrays, and preserves declared fields for valid payloads.
- RED: `rtk proxy node --import tsx/esm --test test/phase14c-contracts.test.ts` -> 12 tests, 10 passed, 2 failed (noncanonical separators and unknown payload fields).
- GREEN: `rtk proxy node --import tsx/esm --test test/phase14c-contracts.test.ts` -> 12 passed, 0 failed, 0 skipped.
- GREEN: `rtk proxy node_modules/.bin/tsc --noEmit` -> exit 0.
- GREEN: `rtk proxy node_modules/.bin/tsc --noEmit --ignoreConfig --strict --types node --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck test/phase14c-contracts.test.ts` -> exit 0.
- GREEN: targeted eslint for the four Task 0.1 files and `rtk proxy git diff --check` -> exit 0.
- No pipeline, storage, package, lockfile, or out-of-scope production files were changed; the query projection file remains unchanged because prior review found it correct.

Fix round 2 report (2026-09-10):
- Reviewer gaps addressed: canonical entity scope/router paths now reject backslashes, dot segments, empty/repeated separators, and traversal without silently normalizing; accepted decoding rejects unknown fields across outputs, provenance, refs, ranges, and entity/subject payloads; serialized ranges, refs, evidence IDs/refs, and provenance are bounded while declared fields are preserved for valid payloads.
- RED: `rtk proxy node --import tsx/esm --test test/phase14c-contracts.test.ts` -> 12 tests, 10 passed, 2 failed (noncanonical separators and unknown payload fields).
- GREEN: `rtk proxy node --import tsx/esm --test test/phase14c-contracts.test.ts` -> 12 passed, 0 failed, 0 skipped.
- GREEN: `rtk proxy node_modules/.bin/tsc --noEmit` -> exit 0.
- GREEN: `rtk proxy node_modules/.bin/tsc --noEmit --ignoreConfig --strict --types node --target ES2022 --module NodeNext --moduleResolution NodeNext --skipLibCheck test/phase14c-contracts.test.ts` -> exit 0.
- GREEN: targeted eslint and `rtk proxy git diff --check` -> exit 0.
- Commit scope remains limited to the three changed Task 0.1 files; `framework-query.types.ts` and all pipeline/storage/package/lockfile files remain untouched.
Task 0.1: fix round 2/5 (3 remaining findings addressed; commits 7477eb0..88b7b63).
Task 0.1: complete (commits 7477eb0..88b7b63, review clean). Note: reviewer reported one environment-only Node typings mismatch during adversarial recheck; implementer had already passed production tsc.

Task 0.2 execution (2026-09-10):
- RED reproduced from the supplied partial diff: `node --import tsx/esm --test test/phase14c-objective-facts.test.ts` reported 6 tests, 4 passed and 2 failed. Kotlin failed `JVM annotations retain ownership, named arguments, parameter links, and Bean return types` because the Kotlin grammar places `@Qualifier` in sibling `parameter_modifiers`, so linking only the `parameter` node cannot back-link the annotation to its `parameter:*` FactLocalId. Dart failed `Dart materializes named widget arguments, generic provider types, and build returns` because `function_signature` and `function_body` are separate siblings; the callable stack was popped after the signature, so collector-created/visited return observations inherited the enclosing class symbol instead of `build`.
- RED reproduced from the supplied partial diff: `node_modules/.bin/tsc --noEmit` reported `facts-codec.ts` lines 359, 360, 362 implicit-any callback parameters and line 400 `Object` of type `unknown`. Root cause was loss of narrowing from dynamic record fields and an untyped `value.nodes` array in `hasObjectiveSyntax`.
- AST/pattern evidence: Java `@Qualifier` is nested under `formal_parameter`, and its existing `syntax.linkFact(parameter, parameterId)` path already works; Kotlin requires linking annotation descendants of the immediately preceding `parameter_modifiers`. Dart `function_body` ownership is carried only for that subtree by temporarily pushing `pendingBodyOwner` onto `callableStack`; no dynamic framework meaning is inferred.
- Fixes: link Kotlin parameter annotations to the created parameter fact; carry Dart function-body ownership through return/lambda traversal; narrow codec nodes to `SyntaxObservation[]` and validate fact arrays before collecting local IDs; update the Phase 14B contract fixture assertions for the additive objective syntax while asserting preserved `expression:3` IDs.
- GREEN: `node --import tsx/esm --test test/phase14b-facts-contract.test.ts` -> 4 tests, 4 passed, 0 failed.
- GREEN: `node --import tsx/esm --test test/phase14c-objective-facts.test.ts` -> 6 tests, 6 passed, 0 failed.
- GREEN: `node_modules/.bin/tsc --noEmit` -> exit 0.
- GREEN: `git diff --check` -> exit 0.
- GREEN: targeted `node_modules/.bin/eslint` over the 8 tracked Task 0.2 source/test paths plus the two created Task 0.2 paths -> exit 0.
- Scope check: `git status --short` lists only the 8 approved tracked paths, `src/core/facts/objective-syntax.types.ts`, `test/phase14c-objective-facts.test.ts`, and this required progress ledger.
- `gitnexus detect_changes --scope all --repo <HOME>/code-atlas` completed with the required stale-index warning: the index was built at `<HOME>/code-atlas`, the current worktree is a sibling clone 150 commits ahead, and results may be stale. It reported 8 files, 1 symbol (`vectorRefreshMode`), 0 affected processes, low risk. Running without `--repo` was blocked by multiple registered repositories; reindexing was not run because the task requires the existing partial worktree/index evidence to remain intact.
