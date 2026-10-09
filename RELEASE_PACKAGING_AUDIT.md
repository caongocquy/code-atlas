# Release packaging audit (candidate for 1.6.1)

Baseline: immutable `v1.6.0`, commit `8f3c2d7671b4d9a9deaa70c83c80c4fccb94689f`.
Original packaging work is isolated on `chore/release-packaging-161`; the current lint/Windows continuation uses `fix/windows-regression-release-readiness`. The current user request authorizes normal commit/push and native candidate CI on that existing fix branch, while preserving all other worktrees.
No version bump, merge, tag, npm publication, GitHub Release or Homebrew update
is authorized. Historical evidence below is preserved; current continuation
results and decisions are recorded first.

## Current release readiness: Windows/lint continuation (2026-10-09)

Branch: `fix/windows-regression-release-readiness`. Starting SHA: `d74b0cf9d8b8e6c9339aa3881b6b1eb6ff639ee6`. Current tested source fix: `40e418aac70ef53fcdac3875275b7be67d9bc0cf`. **v1.6.1 remains NO-GO.** The older portable qualification below is historical evidence for its named SHA, not proof that the current vendored distribution or release branch is green.

Source checkpoint CI (40e418a; subsequent observability commits must be qualified independently):

- [Native parser, consumer and regression matrix 37904100241](https://github.com/caongocquy/code-atlas/actions/runs/37904100241): all four native builds, assembly and **16/16 approved consumer cases pass**; macOS ARM64/x64 and Linux full regressions pass with 49 baseline/candidate failures, zero added/changed failure identities and zero added skips; Windows was still running at this checkpoint.
- [Phase 14B parser platform 37904100362](https://github.com/caongocquy/code-atlas/actions/runs/37904100362): **PASS, 41/41 tests, zero skips** on the current source SHA.

### Current consumer results and remaining default-policy warnings

The matrix uses Node **22.23.3 / 24.21.0**, npm **10.9.9 / 11.19.0**, and pnpm **11.22.0**. All sixteen reviewed-policy consumer installs pass on macOS ARM64/x64, Linux x64 and Windows x64; each actual parser log reports **12/12 AST checks** for TS, TSX, JS, Python, Java, Kotlin, Go, Rust, Swift, Dart, C and C++. Install/parser/dependency-graph exits are zero, all compiler guards pass, and compiler invocation lists are empty. Exact approvals remain only `onnxruntime-node@1.30.0` and `protobufjs@7.6.6`.

Thirty-two raw records preserve the distinction between default and approved installation. Default npm passes 8/8 with actual parsing: npm 10 has no warnings; npm 11 reports five `allowScripts` warning lines per case for the same two hooks. Default pnpm fails 8/8 with `ERR_PNPM_IGNORED_BUILDS` for those hooks; parser/graph checks do not run in those failed default cases. Approved cases contain zero peer, compilation, lifecycle-policy, missing-prebuild or deprecation warnings. No blanket approval, `--force`, `--legacy-peer-deps`, global lifecycle disabling or required-language removal is used. Verbose npm logs also record platform filtering of optional `@img/sharp-*` dependencies; this is not native compilation or a missing parser.

Universal npm artifact: **21,154,720 bytes** compressed (20.175 MiB), **256,814,063 bytes** unpacked (244.917 MiB), 659 files; SHA-256 `e389d1006c8b29689c85dea46dc69684e34f1de30477d049b1e3970e5a403267`. Approved installed own-package sizes range **256,814,063–256,844,957 bytes**. These are npm package measurements, not the historical portable archive/install measurements below. Raw current install logs, dependency graphs, native manifests and assembly evidence are retained in the workflow artifacts and locally under ignored `docs/audits/windows-release-readiness-20261009/ci-37904100241/`.

### Exact lint failure and fix

Both `assemble-package` in [37902063107](https://github.com/caongocquy/code-atlas/actions/runs/37902063107) and the separate [Phase14B run 37902063060](https://github.com/caongocquy/code-atlas/actions/runs/37902063060) stopped at lint on `d74b0cf`. The diagnostic script had six `no-undef` errors for `process` at lines 43, 54 and 60. Phase14B did not reach its parser tests; this was the same lint root cause, not an independently demonstrated parser failure. The consumer matrix was skipped after assembly failed, so that run provides no new consumer-install passes.

`eslint.config.js` now declares only read-only `process` for exactly `scripts/diagnose-windows-graphql.mjs`. It does not disable `no-undef`, broaden Node globals to browser/other scripts, import a new dependency, or alter existing TypeScript lint policy. Actual ESLint checks accept `process` in that diagnostic, reject an unknown identifier there, reject global `process` in an unrelated script, and reject assignment to the read-only global.

Local validation of the source fix:

- `pnpm install --frozen-lockfile`: pass; manifest and lockfile unchanged.
- `pnpm lint` and `pnpm build`: pass on host Node 22.23.2.
- Host payload preparation with official Node 22.23.3: pass; `verify` checks twelve pinned package inventories/architectures. The first build attempt with host Node 22.23.2 was correctly rejected by the exact-header-version guard; the guard was not bypassed.
- Official Node 22.23.3 focused selection: **86/86 pass, zero skips**. This runs the exact seven-file Phase14B workflow selection plus GraphQL B2, distribution, consumer harness and portable pruning tests.
- `diagnose-windows-graphql.mjs`: **32/32 strict iterations pass locally on macOS ARM64**. Each requires facts, exactly one accepted namespace-fixture entity, and an unsupported-origin diagnostic. This is not Windows proof.
- Read-only Ponytail reconciliation additionally ran `pre17e-incremental.test.ts` and `pre17e-noop-gate.test.ts`: **15/15 pass**.

The pre-existing `423e585` change only adds bounded `rm` retries after SQLite close to the three framework fail-fast fixture roots (`maxRetries: 15`, `retryDelay: 100`). Product storage and all framework assertions are unchanged. The pre-existing Windows GraphQL diagnostic emits raw facts/evidence on the first mismatch and exits nonzero; it does not turn failures into passes by retrying assertions. At the source checkpoint the Windows diagnostic step passed, but full-suite/SCIP qualification was still pending. Each of the three completed Unix platforms ran real SCIP with 6/6 pass and zero skips. Full-suite failures remain baseline failures; a green comparison is not a fully passing suite.

Both full-suite steps now stream the identical TAP command through `tee` with `set -o pipefail`, preserving the saved raw log and the nonzero Node exit. The old Windows run exceeded 34 minutes with no visible test progress because all output was redirected; this instrumentation exposes the active test on a fresh run without changing assertions, selection, concurrency, skips or timeouts. A shell self-check captured failure exit 7 and success exit 0 with complete logs; the existing consumer harness passed 8/8 after the change. The next branch SHA must run the full native consumer/regression and Phase14B gates again; this checkpoint does not claim that an untested newer SHA is green.

### Windows fixture ownership fix after observing the stalled candidate

The instrumented [37906291497](https://github.com/caongocquy/code-atlas/actions/runs/37906291497) on `da53414de6ebf34654d5f8c75a2aae4a33120461` again passed all four native builds, assembly and sixteen approved consumers. [Phase14B 37906291407](https://github.com/caongocquy/code-atlas/actions/runs/37906291407) passed **41/41, zero skips**. macOS ARM64/x64 and Linux full-suite comparisons passed. Windows baseline completed in 5m17, but candidate TAP stopped after the fatal-framework fixture (#89) while the next dynamic-JSX fixture failed to complete. Neither this incomplete Windows run nor the cancelled older `37902063107` / `37904100241` is counted as a Windows pass.

Root cause found in `test/framework-semantic-fail-fast.test.ts`: the first two fixtures created an injected `SqliteVectorStore` through `createDefaultProviders(root)` and never closed its independent SQLite connection. The pipeline closes its own `AtlasStore`, not caller-owned injected providers. Retrying `rm` does not release that handle. Node's `rimraf` retries each nested path, so a held database under `.codeatlas/` can multiply retry delays rather than spending one directory-wide retry budget. This explains why the retry-only change was insufficient.

The fixtures now retain the same concrete `SqliteVectorStore`, database path and repository identity, and close it in `finally` before removing the root. Production storage, all **31 assertion lines**, all three test declarations and the existing transient retry options are unchanged. Local fixture tests pass **3/3 on Node 22.23.3 and 24.21.0**, lint and build pass; independent review confirms ownership and failure-path cleanup. The following pushed SHA must be qualified with a fresh full matrix; no Windows pass is inferred from local macOS tests or prior runs.

The `da53414` npm artifact is a separately built output: **21,154,715 bytes**, SHA-256 `dbd88aab7399bd6c211f6cff4e1d0b5e6b32d8d6d4315c89a46b8bccfd7bcafc`; unpacked/installed package measurements and all 32 default/approved outcomes match the source checkpoint above. Seven rebuilt native binaries have distinct hashes with unchanged byte lengths and pinned source revisions; bit-for-bit native rebuild reproducibility has not been established. Its own checksum manifest and all-four-target verification pass, and all sixteen approved consumers parse twelve languages without compilation.

### Ponytail original findings reconciled against current release code

Baseline: read-only audit in Codex chat **Set up Matt Pocock skills**, thread `01a11c7a-093d-76a0-8b2a-2ba4d000bb83`, audit turn `01a11c80-3077-7182-9151-0faff27f0d8f`. It audited a dirty primary checkout, so each finding was checked against committed release source rather than copied as a current claim. The exact original report is preserved in ignored evidence at `docs/audits/windows-release-readiness-20261009/ponytail-original-audit.md`.

| # | Original finding | Current status | Current evidence / release implication |
| --- | --- | --- | --- |
| 1 | HTTP Inspector exposes repository secrets | **Fixed in this continuation** | The HTTP server binds to loopback by default. `/api/source` now requires a graph-indexed path, rejects ignored paths and sensitive filenames, and reads through the checked file handle. Explicit remote binding requires both `CODE_ATLAS_HTTP_HOST` and `CODE_ATLAS_HTTP_ALLOWED_HOSTS`; Host and Origin are validated. Adversarial HTTP integration covers `.env`, ignored/unindexed paths, DNS-rebinding Host and cross-origin Origin. |
| 2 | Symlink bypasses HTTP repository source boundary | **Fixed in this continuation** | `/api/source` rejects symlink components and nested-repository paths, opens the final file with `O_NOFOLLOW` where supported, and verifies canonical path and file identity before and after reading. HTTP integration covers an indexed symlink plus concurrent symlink replacement attempts. |
| 3 | Long owner-context lexical query exceeds SQLite bind limit | **Fixed in this continuation** | Owner context is passed as one JSON value and expanded by SQLite `json_each`, instead of repeating hundreds of SQL bindings per term. Unicode-aware tokenization preserves CJK and accented identifiers. 50-word, repeated-term, Unicode and existing lexical ranking regressions pass. |
| 4 | Stale candidate can replace newer active generation | **Fixed in this continuation** | `publishCandidateGeneration` compares the candidate's recorded parent with the active generation inside its `BEGIN IMMEDIATE` publication transaction. A two-connection competing-candidate regression confirms only the still-current parent can publish. |
| 5 | Config scanning crosses ignored/nested-repo boundaries | **Fixed in this continuation** | Config discovery continues to use resolved Git and repository excludes and now stops at nested repositories identified by a `.git` file or directory. The regression covers ignored config files and nested repositories. |
| 6 | Unchanged semantic sync re-embeds repository | **Fixed for unchanged sync** | Compatible providers plus no semantic-dirty paths enter the no-op gate at `src/core/indexing/index-pipeline.service.ts:557`; no embedding/publication occurs. Fifteen focused Pre17E tests pass, including zero semantic writes on no-op and reuse when one source changes. |
| 7 | Every sync retains another full generation forever | **Partially fixed** | No-op sync reuses the active generation, preserving generation count/database snapshot. Changed-generation retention remains unbounded; no generation-pruning path exists. `deleteUnreferencedFactBlobs` at `src/storage/atlas/atlas.store.ts:1414` cannot collect facts still held by historical generation bindings. |
| 8 | Semantic candidate duplicates legacy/generation vectors | **Open** | `prepareSemanticCandidateFromFacts` at `src/core/semantic/semantic-index.service.ts:96` calls built-in vector upsert, which writes legacy `semantic_vectors` (`src/storage/atlas/sqlite-vector.store.ts:48`); the pipeline then stages `generation_semantic_vectors` at line 986. Duplicate writes/storage remain. |

**Reconciled total: six fixed, two deferred/open.** Finding 6 was fixed by the existing no-op sync gate. Finding 7 (historical generation retention) remains deferred; this request explicitly excludes storage GC. Finding 8 (duplicate legacy/generation semantic vector writes) remains open and was not expanded into this security/correctness slice. Evidence for findings 1–5 is from the isolated `fix/v1.6.1-security-correctness` continuation and its tests below; the stale source/graph index was not used as proof.

### Security/correctness continuation (2026-10-09)

Branch `fix/v1.6.1-security-correctness` starts at verified candidate
`cba67badb7d7ba263e65e551d58de52779bd43cd`. The HTTP source integration covers
`.env`, credential files, ignored and unindexed paths, final and directory
symlinks, symlink replacement, Host rebinding and cross-origin Origin. Lexical
regressions cover 40- and 50-word owner queries, repeated terms, Unicode, and
the existing exact-name/ranking behavior. Config discovery and competing
generation publication have focused regressions.

Local focused run: 25/25 passed. Typecheck and lint passed. Full-suite
comparison against `cba67bad` after building both checkouts passed the
assertion-level comparator: baseline 1,353 pass / 48 fail / 3 skip; candidate
1,358 pass / 48 fail / 3 skip; zero added or changed failure identities and
zero added skips. The suite itself is not green; all 48 failures are present
unchanged at the baseline SHA. Native parser and cross-platform release CI
remain per-SHA gates.

### Current blockers and publication boundaries

1. Findings 1–5 are addressed on the security/correctness continuation and its local full-suite comparison has zero regressions. Per-SHA native cross-platform parser/consumer CI is still required before this continuation can be called release-qualified. Do not count skipped tests or consumers as passes.
2. Finding 7 remains deferred because storage GC is explicitly out of scope; historical-generation retention is still unbounded. Finding 8 remains open because duplicate legacy/generation semantic vector writes were not part of the requested slice. Keep release readiness **NO-GO** until release owners decide whether finding 8 blocks this release.
3. The integrated commit still needs final release qualification of packed CLI/MCP, portable artifacts, macOS x64 ONNX embedding and distribution checks. Run these against the integrated commit; the earlier native results apply only to their named SHAs.
4. The candidate version remains 1.6.0. No version bump, tag, npm publication, GitHub Release or Homebrew update is included in this task.

All other valid worktrees were snapshotted before the fix: 22 checkouts, 2,513 dirty/untracked file hashes plus HEAD/status. A subsequent verification found **zero drift** in all 22 HEADs/statuses and 2,513 file hashes. Changes remain isolated to this branch. No merge, tag, npm/GitHub publication or Homebrew update is authorized or performed.

## Historical native qualification (2026-10-09, 5f91d12)

**GO for v1.6.1 packaging and the authorized Clack migration.** All four native
artifact and regression gates passed on code commit
`5f91d12fc98bd0c2291192721790574231061abc`:
https://github.com/caongocquy/code-atlas/actions/runs/37872719908
The separate native parser matrix also passed:
https://github.com/caongocquy/code-atlas/actions/runs/37872719935
This was the packaging decision at that source SHA; the current-readiness section above governs the ongoing release candidate.

Each installed artifact and each extracted archive passed **9/9 smoke groups with
zero failures and zero skips** (eight smoke runs total). These exercise all native
parser languages, CLI launch/version/help/init/sync, MCP graph/lexical/hybrid tools,
HTTP/UI assets, real external SCIP, React facts, ONNX/Transformers embedding and
local semantic lifecycle. Exact archive content/link/executable inventories passed.
Intel macOS additionally validated 22 final native binaries and their dylib
dependencies. It restored the previously built, pinned full-feature ONNX payload;
architecture/deployment/dependency validation still ran after installation.

Same-run base → candidate measurements, in MiB (1,048,576 bytes):

| Platform | Bundled Node | CI | Archive | Installed logical | Installed allocated |
| --- | --- | --- | ---: | ---: | ---: |
| macOS ARM64 | v24.20.0 | PASS | 228.57 → 116.08 | 912.53 → 444.45 | 961.42 → 487.45 |
| macOS x64 | v24.19.0 | PASS | 229.98 → 106.49 | 915.23 → 408.28 | 974.77 → 450.95 |
| Linux x64 | v24.21.0 | PASS | 448.01 → 327.12 | 1187.61 → 669.60 | 1219.89 → 700.86 |
| Windows x64 | v24.21.0 | PASS | 238.46 → 125.56 | 907.74 → 412.61 | unavailable |

Allocation is filesystem-specific; Windows allocation is unavailable, not zero.
Raw byte measurements:

| Platform | Archive bytes | Installed logical bytes |
| --- | ---: | ---: |
| macOS ARM64 | 239678237 → 121720320 | 956854873 → 466043455 |
| macOS x64 | 241151778 → 111661531 | 959683414 → 428114460 |
| Linux x64 | 469777499 → 343012131 | 1245297418 → 702126382 |
| Windows x64 | 250039529 → 131660402 | 951836098 → 432654558 |

Both full suites use the immutable v1.6.0 base, the same runner/runtime, frozen
installs, built CLI shims and `--test-concurrency=2`. No test or assertion was removed.
The comparator checks assertion details within previously failing tests as well
as failure identities and skips. Every gate reports zero added failures, zero
changed assertions and zero new skips. All cancelled/TODO counts remain zero.

| Platform | Base total / pass / fail / skip | Candidate total / pass / fail / skip | Added / changed / resolved / new skips |
| --- | --- | --- | --- |
| macOS ARM64 | 1349 / 1297 / 49 / 3 | 1382 / 1330 / 49 / 3 | 0 / 0 / 0 / 0 |
| macOS x64 | 1349 / 1297 / 49 / 3 | 1382 / 1330 / 49 / 3 | 0 / 0 / 0 / 0 |
| Linux x64 | 1349 / 1297 / 49 / 3 | 1382 / 1330 / 49 / 3 | 0 / 0 / 0 / 0 |
| Windows x64 | 1349 / 1232 / 114 / 3 | 1382 / 1289 / 90 / 3 | 0 / 0 / 24 / 0 |

The full suite still has inherited failures: 49 on Unix and 90 on Windows. Windows
resolves 24 base failures. The historical Node22 count was 48; Node24 has the same
additional worker `ERR_WORKER_INVALID_EXEC_ARGV` failure in base and candidate.
The three source-suite skips are inherited; packed smoke validation has no skips.
The previous Intel `SIGABRT` did not recur under the equivalent bounded full-suite
environment. Its exact native cause remains unproven; it was neither normalized
nor ignored by the comparator.

Fixes qualifying this run:

- Official ONNX 1.30.0 has no macOS x64 payload. Build the exact pinned upstream
  source with Node bindings, CoreML and WebGPU; install it before target pruning,
  then reject wrong architecture, missing/external dylibs, escaping links and an
  increased deployment floor. Actual installed and extracted embedding passed.
- Swift's production CLI edge caused an unrelated postinstall HTTP 500. Repack the
  integrity-pinned Swift 0.7.1 archive after deleting only that manifest dependency;
  preserve package assets and keep all native lifecycle scripts enabled.
- Windows GNU tar interpreted an absolute drive-letter archive as a remote host.
  Relative archive/destination arguments and the pack-directory cwd fix extraction.
- Windows baseline diagnostics vary by SQLite WAL/SHM cleanup order and random-root
  graph UUIDs. Only those proven equivalent diagnostics are canonicalized; negative
  tests preserve changed metadata, paths, nodes, edges and unrelated assertions.

Source lint passed with `pnpm lint --ignore-pattern '.release/**'`. Bare `pnpm lint`
after packing failed on 1,016 upstream Swift build-source lint errors under generated
`.release/pack`; no CodeAtlas lint rule was relaxed. The generated directory exclusion
is explicit. All four candidate builds and focused native regressions passed.

Candidate archive SHA-256:

- macOS ARM64: `daf72db384784be0777539d49899334a121efa5359bad6fed3ff082caa1d840f`
- macOS x64: `491617858ddea56c6b10128c3f1e50944458bf7bdffe7d9c70d59cb923dce576`
- Linux x64: `9854531f3f93d4f51dfb5591a4b512dc0df37011b7c8d16ddfc18d3252defa49`
- Windows x64: `96e048e4e3f8e83e32307bb9c0dd60230e85298059bcdae25cda94533b9df8f3`

Evidence JSONs are saved under `/private/tmp/code-atlas-ci-evidence-5f91d12/`; the
complete native log is `/private/tmp/code-atlas-5f91d12-all.log`. The documentation-only
follow-up records this completed code run and uses `[skip ci]`; it changes no code,
manifest, lockfile or workflow. The qualified runtime SHA remains the one above.

Outstanding qualification limits: native macOS tests ran on macOS 15, so deployment
metadata at 13.5 is verified but execution on macOS 13.5 and older CoreML APIs is not.
Windows stream/cleanup tests passed, but a real Windows console visual check was not
performed. `doctor` is absent in v1.6.0; its existing Unknown-command failure is
verified rather than introducing a command. The inherited full-suite failures and
unproven historical native abort are recorded separately from the green release gates.
No merge, version bump, tag, npm publication, GitHub Release or Homebrew update was
performed. Phase16C/17 worktrees and immutable v1.6.0 were preserved.

## Continuation: Clack CLI and macOS x64 runtime

The CLI migration is included on this same isolated packaging branch. Human
reporting, progress, multiselect integration selection, semantic setup prompts,
upgrade output and standalone graph adapters use `@clack/prompts@1.8.1`.
`listr2` is removed. JSON/help/version/MCP remain machine-readable. Cancellation,
non-TTY/CI/NO_COLOR and shared core `ProgressReporter` contracts are retained.
The Clack `tasks()` implementation does not stop its spinner on a caught task
failure; the existing progress boundary instead uses `spinner()` with explicit
failure cleanup. Unix tests exercise real PTYs; Windows checks Clack streams and
listener cleanup, without claiming a real console visual inspection.

The macOS x64 defect predates pruning: neither the exact `onnxruntime-node@1.30.0`
npm payload nor the official 1.30.0 release includes an x64 macOS runtime. The
candidate builds the same upstream source at immutable commit
`f2c39fe2f838cf35ce7da92824f5a5e3ee6e88a7`, with Node bindings, shared runtime,
CoreML and WebGPU enabled. It overlays all matching ONNX installs before pruning,
retains relative dylib symlinks, and rejects mismatched package versions, wrong
architectures, missing libraries, external Homebrew/build paths and escaping
symlinks. Bundled Node and all native addons/dylibs are checked with `file`/`otool`.
A full source build is needed because no exact-version C++ x64 dylib asset exists.

Native x64 compilation and actual installed/extracted embedding are qualified in the
final native run recorded above. The native build follows upstream CMake 3.31.8 / Python 3.12 / vcpkg
2025.08.27 setup and can require a long C++/WebGPU build. The source build explicitly targets macOS 13.5, matching bundled official Node24;
`otool -l` validation rejects payload or final bundle binaries with a higher
minimum OS version or missing deployment metadata. This prevents the macOS15
runner from silently raising the runtime floor.

### Equivalent local regression comparison

Both immutable v1.6.0 and candidate ran in native managed worktrees, with Node
24.20.0, pnpm 11.22.0, frozen installs, `pnpm build`, a durable CLI shim,
`CODE_ATLAS_CLI` and matching PATH setup before the full TAP suite. Running from
an unbuilt temporary source directory had extra environment failures and is
excluded from the canonical comparison.

| Equivalent setup | Total | Pass | Fail | Skip | Cancelled / TODO |
| --- | ---: | ---: | ---: | ---: | ---: |
| Release base | 1349 | 1297 | 49 | 3 | 0 / 0 |
| Candidate (6030d65) | 1373 | 1321 | 49 | 3 | 0 / 0 |

The comparison passes: zero new failure identities, zero changed assertions
within existing failing tests, zero resolved failures and zero new skips.
Expected/actual/operator/error values are compared, including nested diagnostics;
only checkout roots and temporary paths are normalized. The 48 historical
Node22 failures remain unchanged. Node24 adds the same baseline/candidate worker
conformance failure (`ERR_WORKER_INVALID_EXEC_ARGV`); this is an inherited
runtime-version difference, not a packaging regression. The three existing skips
are packed CLI paths not provided for the source suite, and optional real SCIP;
artifact CI explicitly supplies the external SCIP compiler and exercises packed
CLI/MCP paths. The full suite is not green.

Raw local evidence:
- `/private/tmp/code-atlas-release-base-native-node24-ci-setup.tap`
- `/private/tmp/code-atlas-release-candidate-node24-ci-setup.tap`
- `/private/tmp/code-atlas-release-baseline-vs-candidate.json`
- `/private/tmp/code-atlas-release-base-native-ci-evidence.json`
- `/private/tmp/code-atlas-node22-vs-node24-ci-setup-report.json`

### Native CI qualification

The publication-free workflow now runs on the authorized branch push, with four
native runners. Each builds and tests the candidate, reruns the full release-base
and candidate suites on the same runner and compares failed assertion details,
measures fresh unpruned/pruned artifacts using the same native compressor,
checks all packed feature paths, snapshots SHA-256 content/link/executable
metadata, extracts the archive, verifies exact inventory and reruns its runtime
smoke. It captures raw test logs, exit statuses, pruning decisions and metrics.
The x64 job builds the pinned ONNX payload and validates it even on cache hits.
No publication workflow is dispatched. Until native qualification succeeds:
**NO-GO for v1.6.1**.

First native run: https://github.com/caongocquy/code-atlas/actions/runs/37760789004
at candidate `9937f2cc765a1b24d77b6bfa0a44e5ae7d90f815` failed all four initial
focused-test steps, before artifact or ONNX qualification. Actual findings:
- CI had not installed its durable compiled CLI shim before the focused suite.
- The Clack fake-TTY assertion compared styled text without stripping ANSI.
- Windows test subprocesses used drive-letter paths as ESM `--import` URLs.
- Existing Windows fixtures assumed POSIX PATH separators, executable names,
  scanner paths and launcher locations.
- Clack honored FORCE_COLOR over NO_COLOR; an explicit NO_COLOR precedence fix
  now has a regression test, including both conflicting environment variables.

These failures are recorded, not counted as platform smoke success. Corrections
retain the existing test assertions and supply platform-correct inputs. The SCIP
Windows shim parser now accepts the standard `%~dp0` form alongside
npm's `%dp0%`; this native portability finding is within artifact verification.

Fresh local ARM64 Clack artifact (before follow-up corrections): 126677200
compressed bytes (120.809 MiB), 475902919 logical installed bytes and 521093120
allocated installed bytes (496.953 MiB); 11792 inventory entries. Real artifact
smoke passed all nine groups, including external SCIP and builtin model embedding.
This local measurement is separate from the pending same-run native CI comparison.


### Native run 37763317039 (6030d65)

https://github.com/caongocquy/code-atlas/actions/runs/37763317039

- macOS ARM64: PASS, including both 9-group runtime smokes and archive inventory.
- Linux x64: PASS, including both runtime smokes and archive inventory.
- macOS x64: full regression comparison PASS; native setup failed before compile
  because PyPI does not provide `cmake==3.31.8`. Replaced that install in both
  workflows with Kitware's official universal macOS archive, pinned SHA-256
  `d1449f969c54d5c00886d5b643340d493dfb3c81cb39ee29b35453395c11ebf7`.
- Windows x64: focused suite failed on remaining profile/path/shim fixtures and
  a real subprocess cleanup race. The candidate fixes Windows fixture inputs
  without dropping assertions. SCIP now waits for child `close` after output-limit
  or timeout termination, preserving the original error before temporary cleanup;
  previously cleanup could fail with EBUSY and mask the output-limit diagnostic.

All three completed native full-suite comparisons are exact: base 1349 tests,
1297 pass / 49 fail / 3 skip; candidate 1373 tests, 1321 pass / 49 fail / 3 skip.
Zero added/changed/resolved failures and zero added skips. Their comparison JSONs
have identical SHA-256 `ff54dcb4bd2e43475dd2358105203892693a5edfa8d211f835d2b7a4f0bb7fef`.
Windows did not reach its full-suite comparison; it remains unqualified.

Native same-run sizes (MiB; installed allocation is runner filesystem-specific):

| Platform | Archive | Installed logical | Installed allocated |
| --- | ---: | ---: | ---: |
| darwin-arm64 | 228.58 -> 116.09 | 912.53 -> 444.45 | 967.71 -> 488.12 |
| linux-x64 | 448.00 -> 327.12 | 1187.61 -> 669.60 | 1219.90 -> 700.87 |

Native evidence JSONs: `/private/tmp/code-atlas-ci-evidence-6030d65/`.
Raw local committed candidate: `/private/tmp/code-atlas-release-6030d65-node24.tap`
and `/private/tmp/code-atlas-release-6030d65-comparison.json`.
The follow-up still requires a complete native rerun. **NO-GO** until qualified.

### Follow-up native run 37773118412 (9cff9e7)

https://github.com/caongocquy/code-atlas/actions/runs/37773118412

The SCIP output-limit cleanup regression passed on native Windows. Two remaining
focused failures were test-harness defects: 8.3 versus long Windows directory
spellings, and fixture removal before the MCP child released its current directory.
The tests now compare actual filesystem realpaths, close MCP stdin, wait for the
child close event and assert a zero exit code before cleanup. No product assertions
were dropped. Local Node24 focused suite: 21 pass, 1 pre-existing optional SCIP skip.

Full local 9cff9e7 suite: 1373 tests, 1321 pass / 49 fail / 3 skip, with zero new or
changed failure assertions against the exact release base. Evidence:
`/private/tmp/code-atlas-release-9cff9e7-node24.tap` and
`/private/tmp/code-atlas-release-9cff9e7-comparison.json`.

The failed intermediate run is superseded by a complete matrix on the corrected
fixture commit. Its unfinished jobs are not counted as qualification successes.

`doctor` remains absent in the release base; its explicit unknown-command/exit-1
contract is tested. This task does not add a new command or claim doctor passed.

## Audit before implementation

The four published archives and SHA-256 sidecars are the historical baseline.
The installed Homebrew ARM64 bundle uses Node v24.20.0; `du -sk` reports
848308 KiB of node_modules and 119056 KiB of runtime. Package directory sizes
include descendants and must not be summed as independent contributions.

- Release Artifacts builds each target on a native runner with Node 24 and
  `pnpm install --frozen-lockfile`, then runs the portable packager. It packs
  only `dist` plus npm automatic manifest/README/license files. The packager
  installs that tarball into a fresh directory using `npm install --omit=dev`
  with lifecycle scripts enabled, and copies the executing Node binary.
- Thus build dev dependencies do not leak directly into portable artifacts.
  Transitive production dependencies, peer installations, package source,
  prebuilds, postinstall outputs and maps do. npm install has no lockfile:
  rebuilding the same tag can resolve newer transitive versions. Historical
  archive transformation and fresh builds must be reported separately.
- Publish uses exact tag/version checks, build/test and packed consumer checks,
  then npm Trusted Publishing. GitHub Release waits for the exact npm version;
  artifacts attach after all four builds. These channels remain intact.
- Homebrew lives in `caongocquy/homebrew-showdar`, separate from this repo.
  Its formula copies the portable bundle into libexec and wraps its bundled
  Node. The hourly/manual sync waits for both macOS assets and checksums.
  Local tap inspected and remote HEAD verified as
  `f4dced17a1e80e179af32980ec70d4882ee788a5`.
- `onnxruntime-node` 1.30.0 contains several OS/CPU payloads. The binding
  dynamically requires `bin/napi-v6/${process.platform}/${process.arch}`.
  All files inside the selected target directory must be retained.
- `onnxruntime-web` is a Transformers production dependency, not a dev leak.
  Transformers 4.3.0 selects a Node ESM build containing the WebGPU backend
  and requiring ONNX Node. WASM/backend consolidation is not safe to infer
  from application static imports. Preserve both packages and their WASM/JS.
- `@showdar2112/code-atlas` is about 2.8 MiB dist plus 154 MiB nested
  dependencies, mostly grammars: CPP, TypeScript, Kotlin, Python, JavaScript,
  Java, Go and an additional tree-sitter runtime. This is npm peer placement,
  not a second copy of CodeAtlas. Do not dedupe incompatible peer versions.
- Swift 0.7.1 ships roughly 53 MiB native grammar sources and 19 MiB prebuilds.
  Its runtime binding uses node-gyp-build and reads src/node-types.json.
  TypeScript also reads typescript/src and tsx/src/node-types.json. Removing
  complete src directories would lose runtime parser metadata.
- Swift incorrectly makes tree-sitter-cli a production dependency. It is used
  for grammar generation/playground scripts; bindings load existing native
  addons. CodeAtlas does not spawn it. Verify all native grammars before
  excluding this build tool from portable bundles; npm metadata stays intact.
- SCIP protobuf handling is shipped. scip-typescript is intentionally discovered
  in the indexed project or PATH, never implicitly downloaded. Test available,
  absent, failed, timeout and malformed-output paths.
- Dashboard dependencies are production declarations; the released UI is a
  Vite build in dist/ui served by Fastify. Do not remove React/highlight/sigma
  or alter lazy route extraction in this packaging-only task.

## Implementation and verification plan

1. Preserve immutable archives/checksums and measure exclusive package bytes.
2. Add a narrow post-install pruning pass with tests for target selection,
   universal prebuilds, nested grammars, node-types preservation and failures.
3. Keep product code, dependencies and npm tarball content unchanged.
4. Run actual artifact parser/ONNX/MCP/UI/CLI smokes and existing semantic,
   SCIP and React lazyRouteNamed regressions; measure compressed and installed
   contents using the same tools before/after.
5. Add a publication-free native CI matrix. Cross-platform archive transforms
   are size evidence only; foreign-platform runtime validation requires CI.
6. Report exact test outcomes and remaining release gates before any 1.6.1 tag.

## Measured platform footprints

All sizes below use MiB (1,048,576 bytes), not decimal MB. Historical downloads
were fetched from the published v1.6.0 release and verified against all four
SHA-256 sidecars. Installed sizes are `du -sk` on extracted copies on this Mac;
Windows/Linux filesystem allocation can differ. Compressed after sizes are
measured archive transformations, not claims of new native CI builds. Unix uses
`tar -C <bundle> -czf <archive> .`; Windows uses Python ZIP_DEFLATED level 9,
so its ZIP figure is provisional relative to PowerShell Compress-Archive.

| Platform | Published compressed | Pruned compressed | Extracted installed before | Pruned installed | Native candidate smoke |
| --- | ---: | ---: | ---: | ---: | --- |
| macOS ARM64 | 228.57 | 117.18 | 944.71 | 476.10 | passed |
| macOS x64 | 229.98 | blocked | 947.45 | blocked | missing baseline ONNX binding |
| Linux x64 | 448.01 | 328.11 | 1214.12 | 701.31 | pending CI |
| Windows x64 | 238.45 | 122.27 | 940.09 | 444.36 | pending CI |

The fresh ARM64 install differs from the historical artifact because portable
npm installation is not locked. With the unchanged packager and the optimized
packager, using the same release source and Node v24.20.0:

| Fresh local build | Before | After | Reduction |
| --- | ---: | ---: | ---: |
| Compressed archive | 233.37 | 120.88 | 48.2% |
| Installed (`du -sk`) | 972.48 | 497.39 | 48.9% |

Exact fresh archive bytes: 244703446 before; 126750920 after. Allocated installed
KiB: 995816 before; 509332 after. Both installs used lifecycle scripts and no
repository/global node_modules. The modified packager ran a fresh installation,
not just an in-place directory transform. Its version remains 1.6.0 intentionally;
these are review artifacts, not a published 1.6.1 release.

## Major components and classification

This is an exclusive ARM64 breakdown: nested packages are attributed to their
own package name. Installed columns count regular-file logical bytes, unlike
the allocated platform table above. Compressed columns are independently
compressed tar partitions (gzip level 6); they are not additive measurements
of the release archive, whose compression depends on ordering and metadata.

| Component | Required by | Installed before/after MiB | Standalone compressed before/after MiB |
| --- | --- | ---: | ---: |
| ONNX Node | optional local semantic CPU inference | 287.12 / 85.36 | 106.08 / 24.27 |
| ONNX Web | Transformers backend/WASM distribution | 138.18 / 117.58 | 31.80 / 27.55 |
| Swift grammar | native parser | 72.39 / 3.99 | 4.91 / 0.37 |
| CPP grammar | native parser | 40.43 / 6.80 | 3.11 / 0.58 |
| TypeScript/TSX grammar | native parser | 37.04 / 5.78 | 2.86 / 0.57 |
| tree-sitter-cli | grammar build/playground only | 20.05 / 0 | 7.12 / 0 |
| Transformers | optional local semantic loader/tokenizer/model pipeline | 9.43 / 9.43 | 2.18 / 2.18 |
| Bundled Node | every portable runtime path | 116.26 / 116.26 | 37.41 / 37.41 |

Other core dependencies (chalk, figures, listr2, config parsers, ignore, uuid,
zod and graphology) remain. Tree-sitter runtime and every grammar remain;
SCIP protobuf/scip dependencies remain; the optional external scip-typescript
compiler is not bundled. Fastify/static/MCP SDK remain for HTTP and MCP. Built
Vite assets and React/react-dom/sigma/highlight declarations remain. TypeScript,
Vite, tsx, Babel, ESLint and Inspector are build/dev tools and are absent from
the fresh portable consumer. Transitive @types packages can still be installed
through peer/production declarations; those are not evidence that --omit=dev
failed. No package manifest or lockfile was changed.

## Implemented decisions

- Only after npm lifecycle scripts complete, inspect physical package directories,
  including scoped and nested packages. Do not follow symlinks out of the bundle.
- Retain only the selected OS/CPU ONNX native directory. Preserve all libraries
  and providers within it, including Linux CUDA libraries and Windows DirectML.
- Retain matching grammar prebuild tuples, including universal tuples containing
  the requested CPU. Preserve unknown tuple formats rather than guessing.
- Remove grammar C/C++ sources/headers, object files, grammar.json, and build
  object directories. Keep bindings, installed .node binaries, node-types.json,
  other JSON metadata, queries and licenses. Existing build/Release native addons
  retain loader precedence; do not dedupe potentially different ABI builds.
- Exclude the audited tree-sitter-cli 0.23.2 package and its bin shims from the
  portable artifact. It was a Swift transitive production declaration but has
  no CodeAtlas runtime caller. A future version is retained until re-audited.
- Remove only source maps in ONNX/Transformers dist. Keep both ONNX backends,
  every WASM file and JS export. No provider is disabled or newly downloaded at
  normal CLI startup.
- Reject OS/CPU labels differing from the build host before clearing .release.
  Validate required ONNX target directories before any pruning. Missing target
  is a packaging failure, never an instruction to ship a broken semantic backend.
- Save .release/pruning.json outside the distributable for review. Refresh the
  helper with the packager on manual release backfills. No existing release/tag
  has been modified or backfilled during this task.
- Add a four-platform publication-free CI workflow and actual artifact smoke
  harness. It installs an external SCIP compiler only in runner temp for tests.

## macOS x64 release blocker

The original checksum-verified v1.6.0 x64 archive contains x86_64 Node v24.19.0,
but ONNX Node 1.30.0 contains only darwin/arm64. dist/binding.js directly requires
bin/napi-v6/${process.platform}/${process.arch}/onnxruntime_binding.node.
install-metadata.js declares no darwin/x64 download. The original x64 Node was
executed under Rosetta: `--version` passed; requiring onnxruntime-node failed
with MODULE_NOT_FOUND for ../bin/napi-v6/darwin/x64/onnxruntime_binding.node.
This failure predates pruning and is not a native x64 CI qualification.

The new guard correctly blocks pruning this archive. Do not substitute the ARM64
binary, remove the Node backend, silently choose WASM, downgrade ONNX or change
Transformers without a separately validated compatibility decision. A supported
x64 ONNX/Transformers combination is a prerequisite for a full 1.6.1 release.

## Homebrew alternatives

A: Keep self-contained portable archives for v1.6.1. After pruning, the portable
runtime remains predictable, works without global Node, and reuses the current
tap sync/checksum workflow. This is the recommended immediate option: lowest
maintenance and compatibility change, with about half the ARM64 footprint.
Node is duplicated if users already have it and runtime security updates require
rebuilding CodeAtlas artifacts.

B: A distinct Homebrew runtime-less archive and `depends_on "node"` would remove
116.26 MiB installed / roughly 37.41 MiB compressed from the CodeAtlas ARM64
payload. Users without Node still download/install Homebrew Node and its system
dependencies; total disk/download savings are not necessarily that amount.
Users with Node benefit from sharing and Homebrew security updates. Runtime
upgrades become independent of CodeAtlas: test the actual resolved Node version,
SQLite behavior and native addon compatibility. A versioned Node formula could
improve reproducibility, but adds a separate lifecycle/maintenance decision.
Removing runtime/node only during formula install cannot reduce download size.
If B is pursued, use a distinct archive, update the tap generator/wrapper and
checksums, and test both Mac architectures. Do not merely point the current
formula at a portable archive with a missing bundled runtime.

## Remaining opportunities and risks

- Preserve Linux target CUDA payloads: installed ONNX remains 304.63 MiB after
  pruning. CUDA elimination needs a CPU-only backend policy and real provider
  tests; it is not safe platform pruning and was not applied.
- ARM64 ONNX ships two byte-size-equal 42.52 MiB dylib names. Deduplicating them
  with links could save another roughly 42.5 MiB installed after verifying exact
  file equality, loader behavior, archive extraction and Homebrew link handling.
  This pass preserves all selected native libraries.
- ONNX Web retains about 117.6 MiB logical contents. Eliminating backend JS/WASM
  distributions requires a complete device/backend loading contract and tests;
  model and loader behavior were not changed for footprint targets.
- Native parser peer duplication can only be consolidated after grammar/ABI
  compatibility work. Do not override tree-sitter versions just to flatten npm.
- A locked portable consumer dependency graph would improve reproducibility;
  it is a separate packaging maintenance change. Current measured historical
  and fresh build results are explicitly distinguished above.

## Review and release plan

The implementation is ready for local review, with release blockers still open.
No tracked product source, manifest, lockfile or index semantics were changed.
The Phase 16C checkout was not edited. Branch source remains at the v1.6.0 base;
there are no commits, pushes, merges, tags or publications from this task.

1. Review this diff and choose a supported macOS x64 semantic runtime combination.
2. With explicit commit/push approval, run Portable packaging smoke on all four
   native runners. The new local workflow cannot run remotely while uncommitted;
   no CI success is claimed for Linux/Windows/macOS x64.
3. Require all artifact smokes, package/grammar/provider contracts and exact test
   failure attribution to pass or receive an explicit baseline disposition.
4. Only then prepare 1.6.1 version/changelog metadata and rerun the release gates.
5. Obtain explicit release/tag approval, then use existing npm -> GitHub Release
   -> portable assets/checksums -> Homebrew sync channels. Never move v1.6.0.

## Verification evidence and reproduction

Executed in the isolated worktree unless a temporary path is explicitly shown.
Commands below omit the local `rtk proxy` prefix for portability.

| Exact relevant command | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | passed; isolated build dependencies |
| `pnpm build` | passed before and after packaging changes |
| `node --import tsx/esm --test test/release-bundle-pruning.test.ts` | 5 passed; initial no-op implementation failed both original assertions |
| `pnpm exec eslint scripts/package-release-bundle.mjs scripts/prune-release-bundle.mjs scripts/smoke-release-bundle.mjs test/release-bundle-pruning.test.ts` | passed |
| `ruby -e 'require "yaml"; ARGV.each { |file| YAML.load_file(file) }' .github/workflows/portable-packaging-smoke.yml .github/workflows/release-artifacts.yml` | passed |
| `git diff --check` | passed |
| `node --import tsx/esm --test test/semantic-*.test.ts test/phase16b-*.test.ts test/phase14b-parser-packaging.test.ts test/react-lazy-route-framework.test.ts` | 52 passed, 1 optional real-SCIP skip |
| `CODE_ATLAS_SCIP_SMOKE=1 PATH="/private/tmp/code-atlas-packaging-scip-tool/node_modules/.bin:$PATH" node --import tsx/esm --test test/phase16b-scip-indexer.test.ts` | 5 passed, 0 skips; pinned real compiler 0.4.0 |
| `CODE_ATLAS_SCIP_SMOKE=1 PATH="/private/tmp/code-atlas-packaging-scip-tool/node_modules/.bin:$PATH" node scripts/smoke-release-bundle.mjs .release/bundle` | 9 passed, 0 skips on fresh ARM64 artifact |
| `npm pack --dry-run --json` | 498733 compressed bytes; 2239191 unpacked bytes; 269 files; no unexpected published files |
| `pnpm test` baseline | 1298 passed, 48 failed, 3 skipped; Node v22.23.2 |
| `pnpm test` candidate comparison | 1300 passed, same 48 failed, 3 skipped; Node v22.23.2; two added tests at comparison time |

Three further target-selection cases subsequently passed in the final five-test
pruning command. Full-suite failure names, not only counts, were compared:
zero new names, zero resolved names. These are inherited v1.6.0 failures in the
same worktree/dependency environment; no all-green regression-suite claim is made.
Do not merge unrelated feature fixes to make this packaging branch appear green.

Artifact tests use the bundled Node, a fresh temporary HOME/USERPROFILE/XDG,
empty NODE_PATH, a source fixture outside the repo, and the real installed
production package. Unix launcher also runs with PATH=/usr/bin:/bin. All 12
supported grammar variants load and parse. CLI init/sync and version pass;
invalid semantic provider input fails; MCP initializes and lists/calls tools,
including missing-index errors. Lexical, graph and hybrid retrieval work;
local semantic model setup, embedding, CLI sync, vector retrieval, public MCP
hybrid vector results, test and disable lifecycle pass. Web root, built JS,
health and API input failure pass. Real external SCIP discovery and enrichment
match packed facts; absent compiler remains optional. React lazyRouteNamed
index/sync proof passes and a renamed target fails without publication.

`code-atlas doctor` is absent in v1.6.0. Its existing unknown-command exit 1 is
verified; it is not reported as a successful doctor check and no new command
was added. Full native smokes on Linux/Windows/x64 Mac are pending. macOS x64
was tested only for the original ONNX failure under Rosetta, not qualified as
a successful native candidate. The CI matrix is prepared but not dispatched:
remote execution of this new uncommitted workflow needs commit/push approval.

Graph scope: GitNexus does not index the release packager (impact returned
UNKNOWN / target not found), and its semantic definitions included obsolete
paths. Direct source/current-workflow inspection was used instead. The existing
packager's only tracked caller is Release Artifacts; the new helper additionally
has a regression-test caller. No product function/class/method was edited.

Artifacts and raw evidence are preserved in temporary directories:

- `/private/tmp/code-atlas-packaging-161-baseline`: all original archives/sidecars.
- `/private/tmp/code-atlas-packaging-161-measured/sizes.json`: all measured platforms.
- `/private/tmp/code-atlas-packaging-161-measured/*-pruned-paths.json`: exact decisions.
- `/private/tmp/code-atlas-component-sizes.json`: exclusive component partitions.
- `/private/tmp/code-atlas-packaging-failures.json`: exact baseline/candidate names.
- `/private/tmp/code-atlas-packaging-final-smoke.log`: final artifact smoke.
- `/private/tmp/code-atlas-packaging-161-final-arm64.tar.gz`: fresh candidate archive.
- `/private/tmp/code-atlas-packaging-161-final/bundle`: extracted fresh candidate; moved
  out of the worktree after validation to keep generated files out of review.

Temporary artifacts are not staged or committed. Repeat the fresh build with:

```sh
pnpm install --frozen-lockfile
pnpm build
RELEASE_PLATFORM=darwin RELEASE_ARCH=arm64 node scripts/package-release-bundle.mjs \
  --tool code-atlas --bin-name code-atlas --package-name @showdar2112/code-atlas \
  --package-dir . --entry dist/cli.js --version 1.6.0
node scripts/smoke-release-bundle.mjs .release/bundle
```

Use Node 24 for the packager. The smoke harness re-executes itself with the bundled
Node. Enable CODE_ATLAS_SCIP_SMOKE=1 with a separately installed compiler on PATH
to require real SCIP enrichment; the native CI matrix does this automatically.
The existing Release Artifacts workflow now also runs artifact smokes before
archiving (real SCIP remains a separately installed CI smoke dependency).

### Exact inherited regression failures

- MCP lifecycle, lexical search, graph queries, and Phase 9 tools reuse core services
- facts graph preserves clean-fixture graph nodes and edges
- incremental graph matches a clean full rebuild for imports, calls, extends, malformed, delete, and rename
- extracts one path-neutral fact blob from a TypeScript source snapshot
- records containment ownership for symbols, calls, and references
- extracts export-star facts with their source module
- malformed source publishes reusable deterministic partial facts
- index work counters observe importer invalidation and uncertain resolution fallback
- facts graph does not parse again for member and extends resolution
- facts materialization preserves columns for same-line symbols
- facts member evidence preserves executable template interpolation
- facts evidence handles nested template interpolation and masks nested regex literals
- v3 facts round-trip and v2 facts miss without mutation
- resolution 1.1.0 re-resolves unchanged TypeScript facts without changing facts/framework domains
- B2 changes only framework materialization version
- workspace_package_links real indexed root manifest produces exact qualified candidate
- workspace_package_links preserves dependencies, source without name, private/version-independent duplicate targets
- workspace_package_links preserves devDependencies, source without name, private/version-independent duplicate targets
- workspace_package_links preserves peerDependencies, source without name, private/version-independent duplicate targets
- workspace_package_links preserves optionalDependencies, source without name, private/version-independent duplicate targets
- workspace_package_links supports exactly the registry grammar and keeps all other specs unresolved
- workspace_package_links exact name validation, independent roles and four separate section declarations
- workspace_package_links selector validation and workspace v1 exclude unlisted siblings
- workspace_package_links imports, tsconfig aliases, folder/display/remote and nested manifests never create links
- workspace_package_links isolates missing target and never converts unknown into unmatched
- workspace_package_links isolates duplicate target and never converts unknown into unmatched
- workspace_package_links isolates complete target and never converts unknown into unmatched
- workspace_package_links isolates inputKey target and never converts unknown into unmatched
- workspace_package_links isolates scope target and never converts unknown into unmatched
- workspace_package_links isolates kind target and never converts unknown into unmatched
- workspace_package_links isolates values target and never converts unknown into unmatched
- workspace_package_links isolates section target and never converts unknown into unmatched
- workspace_package_links isolates name target and never converts unknown into unmatched
- workspace_package_links isolates json target and never converts unknown into unmatched
- workspace_package_links isolates database target and never converts unknown into unmatched
- workspace_package_links isolates legacy target and never converts unknown into unmatched
- workspace_package_links missing root differs from certified root without name; malformed source section fails only source role
- workspace_package_links filtered-out roles do not query config and no package filesystem fallback
- workspace_package_links bounded fan-out charges derived work without materializing all pairs
- workspace_package_links global payload budget preserves all member/vector slots
- workspace_package_links identical config evidence refs remain repository qualified and compact/full inspection is identical
- workspace_package_links Java and manifest-only targets are unsupported, mixed Java/TS target remains eligible
- workspace_package_links packageName preflight excludes unrelated over-budget dependency declarations
- workspace_package_links reserves projected work before detail construction at deadline
- workspace_package_links global record budget counts declarations and preserves partial member coverage
- workspace_package_links missing index isolates healthy target and source-only invalid name still declares dependencies
- workspace_package_links folder/display equality and same remote never supply package identity
- workspace_package_links stops projection sizing once the shared detail limit is exhausted

## Files changed for review

- `scripts/package-release-bundle.mjs`: post-install pruning and host target guard.
- `scripts/prune-release-bundle.mjs`: audited native/build-file pruning.
- `scripts/smoke-release-bundle.mjs`: real isolated artifact feature tests.
- `test/release-bundle-pruning.test.ts`: five portable pruning regressions.
- `.github/workflows/release-artifacts.yml`: helper backfill and artifact smoke gate.
- `.github/workflows/portable-packaging-smoke.yml`: publication-free native matrix.
- `RELEASE_PACKAGING_AUDIT.md`: audit, sizes, decisions and release gates.

## Native qualification update (2026-10-08)

The isolated branch was committed and pushed as `chore/release-packaging-161`.
The first native run exposed a real macOS x64 toolchain issue: ONNX Runtime's
pinned CoreML source references `MLOptimizationHints` (macOS 14.4+) and
`MLSpecializationStrategy` (macOS 15+) while targeting macOS 13.5, and Clang
promotes those availability warnings to errors. The runner also confirmed the
source was built for `x86_64` with CoreML and WebGPU enabled. The build helper
now passes the narrow availability-warning override to both C++ and Objective-C++
compiler flags; the follow-up native x64 build is still running, so this change
is not yet qualified.

Run `37807771156` on commit `b0d12895b3f4b58e681b563468175d9e54357fb4` has
completed Linux x64 and macOS ARM64 successfully. Windows x64 artifact build,
all 9 packaged runtime smokes, ZIP extraction and integrity checks passed; its
full-suite regression gate failed on changed assertions in three tests. The
Windows baseline/candidate comparison was run under Node 24.21.0:

| Platform | Base archive | Candidate archive | Base installed (logical) | Candidate installed (logical) | Full-suite comparison |
| --- | ---: | ---: | ---: | ---: | --- |
| Linux x64 | 448.1 MiB | 327.1 MiB | 1,187.5 MiB | 669.6 MiB | pass; base 1,349 tests (1,297 pass / 49 fail / 3 skip), candidate 1,376 (1,324 / 49 / 3); no changed/added assertions |
| macOS ARM64 | 228.5 MiB | 116.1 MiB | 912.4 MiB | 444.5 MiB | pass; base 1,349 tests (1,297 pass / 49 fail / 3 skip), candidate 1,376 (1,324 / 49 / 3); no changed/added assertions |
| Windows x64 | 238.4 MiB | 125.5 MiB | 907.5 MiB | 412.7 MiB | fail; base 1,349 (1,232 pass / 114 fail / 3 skip), candidate 1,377 (1,284 / 90 / 3); 0 added failures, 24 resolved, 3 changed assertions |
| macOS x64 | pending | pending | pending | pending | native build in progress |

The three Windows assertion changes are confined to existing failing tests:
two SQLite teardown failures report `EBUSY` while removing `atlas.db` or its
WAL file (the specific file varies between runs), and one incremental graph
assertion shows duplicate file identities for forward-slash and backslash paths.
The test files are unchanged from the release base. These failures point to
existing Windows file-handle cleanup and path-normalization defects, not a
packaging-only candidate failure, but the strict comparator remains red and
the gate is not counted as passing. No test or skip was weakened.

The published `doctor` command is absent from the immutable v1.6.0 release base;
its unknown-command behavior was checked and no command was added as part of
this packaging change. CLI, sync, parsers, semantic provider, MCP, and artifact
runtime checks are covered by the 9 isolated package smoke suites on the passing
platforms. The current run still needs a completed native macOS x64 build and
artifact checks before this audit can make a four-platform qualification claim.

The Windows path-normalization change in `bfae465` preserves escaped JSON
sequences while normalizing only CI temporary roots; it does not hide nested
file-name differences. The regression comparison unit suite passed 13/13.
The ONNX build-argument test suite passed 7/7 after adding the C++ compiler flag.
The pushed CI run is the evidence source for the matrix; sizes above are
installed logical-byte and compressed archive measurements from its native
artifacts, converted using 1 MiB = 1,048,576 bytes. This section supersedes the
earlier statement that no commit, push, or CI run had occurred.

Release status remains **NO-GO** until macOS x64 completes its native artifact
smoke and dynamic-library checks, and the three Windows changed assertions are
reviewed against the release base as accepted baseline defects or fixed without
weakening their tests. No tag, merge, npm publication, GitHub Release, or
Homebrew update has been made.


### Latest native run 37823137359 (66c3633) — Windows result correction

GitHub Actions run: https://github.com/caongocquy/code-atlas/actions/runs/37823137359

The saved Windows x64 candidate evidence confirms the full-suite regression
comparator is **FAIL**. Artifact creation, ZIP extraction and all 9 artifact
runtime smoke groups passed. The Windows baseline had 1,349 tests (1,232 pass,
114 fail, 3 skip); the candidate had 1,377 (1,284 pass, 90 fail, 3 skip). There
were zero added failure identities, 24 resolved failures, two changed existing
assertions and zero added skips. The changed identities are:

- `framework-semantic-fail-fast.test.ts :: known dynamic JSX publishes partial
  framework and runs semantic once`: both runs fail Windows SQLite teardown
  with `EBUSY`, but the locked WAL/SHM file differs.
- `phase0-incremental.test.ts :: incremental sync handles unchanged, one changed
  importer impact, deletion, and deterministic output`: the actual graph contains
  duplicate logical paths using slash and backslash spellings.

These test files are unchanged from the release base, so this is not attributed to
the packaging diff. The strict assertion comparator nevertheless remains red; do
not count Windows full-suite qualification as passing. The candidate archive is
125.54 MiB (131,667,678 bytes), versus 238.42 MiB (250,029,510 bytes) for the
base. Logical installed size is 412.72 MiB (432,655,095 bytes), versus 907.52 MiB
(951,836,098 bytes) for the base. Candidate SHA-256 is
`c86eb227dd92e7d17c80748bcc67c2811ff3f7ed5e2cab97d5a08f5b675fedab`. Raw JSON
evidence is under `/private/tmp/code-atlas-ci-evidence-66c3633/windows-x64/`.

The same run reports macOS ARM64 and Linux x64 jobs successful. macOS x64 was
still running its native ONNX build at the last available status snapshot; the
GitHub API was unreachable during this audit update, so its final job and artifact
results remain unverified here. Therefore the four-platform matrix is incomplete
and the release remains **NO-GO**.


## Blocker remediation (2026-10-09)

Run 37823137359 completed with successful native x64 ONNX compilation and payload
validation. Its final failure was production installation of `tree-sitter-cli@0.23.2`: the
postinstall download of `tree-sitter-macos-x64.gz` returned HTTP 500. The later audit-only
run 37827300081 passed all macOS x64 artifact checks, confirming the native ONNX and
linked-library implementation works when that unrelated download succeeds. Windows
still failed its regression gate on that run. Neither run is four-platform qualification.

`tree-sitter-swift@0.7.1` declares the CLI as a production dependency even though its
runtime binding only loads `node-gyp-build` and `src/node-types.json`; the CLI is used
by the generation/playground scripts. The portable packager now verifies the original
Swift tarball against its pinned SHA-512 integrity, removes only this dependency from
an extracted manifest and installs the otherwise unchanged package via an npm override.
The temporary override is removed from the bundle manifest after install. Grammar
install scripts remain enabled, and the published CodeAtlas manifest and lockfile are
unchanged. A local offline install regression reproduces the failing CLI download, then
proves native lifecycle execution and preservation of parser/metadata bytes with the fix.

Raw Windows baseline/candidate TAP from run 37823137359 was replayed. For the incremental
graph test, both expected and actual snapshots have exactly the same nodes, edges and
metadata; only repository-root-derived UUIDs and their sort order differ. The comparator
now canonicalizes UUIDs by unique node metadata for that one test identity, retaining
slash/backslash spelling, duplicate-path nodes, all metadata, edge multiplicity and
connectivity. Unknown endpoints, ambiguous node identities and other UUID assertions
remain byte-sensitive. SQLite cleanup normalization only treats `atlas.db`, `atlas.db-wal`
and `atlas.db-shm` as one database family for an `EBUSY unlink` inside a generated
CodeAtlas fixture's `.codeatlas` directory. Error code, operation, fixture and database
identity remain significant. No failed test is skipped or suppressed.

The original raw TAP replay now passes: zero added failures, zero changed assertions,
zero new skips and 24 resolved baseline failures. The 30 focused pruning, ONNX, Swift
install and comparator regressions pass; targeted lint and build pass. The fresh installed ARM64 artifact passed all 9 smoke
groups, including real external SCIP, without skips. Negative tests
retain failures for changed graph nodes, paths, duplicate identities, edges, metadata,
SQLite errno/operation/fixture/database and unrelated UUID assertions. Native payloads
are now cached immediately after their successful build/validation so a later artifact
install failure does not discard the expensive build.

A complete native matrix on the fix commit is required before **GO**. Final results and
sizes will be recorded below after all four artifact smoke and regression gates finish.


### Follow-up run 37867445035 (5f574f9)

ARM64 and Linux jobs passed. Windows' full-suite comparator passed with zero added
failures, zero changed assertions, zero new skips and 24 resolved baseline failures
(114 baseline failures versus 90 candidate failures). The Windows artifact failed
before installation: GNU tar interpreted the absolute Windows drive-letter archive
argument as a remote host. Extraction now uses relative archive/destination paths with
its pack directory as the working directory. Lifecycle scripts remain enabled.

Intel macOS built and verified the final artifact, including native ONNX architecture,
dylib dependencies, all nine smoke groups and archive integrity. Its full-suite gate
correctly rejected one new test-process failure: `phase15d-acceptance.test.ts` aborted
with `SIGABRT` during the two-evaluation acceptance test. There are no changes to that
test, evaluator or core parser implementation against v1.6.0. TAP lacks a native crash
trace, so its underlying cause remains unproven. Both full-suite runs now use the same
explicit two-process concurrency bound, retaining every test and assertion. This is
validation environment control, not a comparator exception. Raw host crash-report
upload was rejected by automatic approval review because it could export sensitive
data; it was not implemented. A new four-platform run is required.
