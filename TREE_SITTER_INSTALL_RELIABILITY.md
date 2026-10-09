# Tree-sitter installation reliability implementation

Implementation date: 2026-10-09. Authoritative before baseline: `TREE_SITTER_INSTALL_AUDIT.md` (unchanged). Tested source SHA: `1d2db007577ed56007312f5ce92e8c7068cf95f5`. All sixteen approved clean consumer gates pass. Both Windows full-suite attempts fail on different added identities, retained below. **Consumer installation gates pass; overall qualification and v1.6.1 publication remain NO-GO.**

## Distribution change

Tree-sitter 0.25.1 and all eleven grammar package versions/source tarball integrities are pinned in `scripts/parser-sources.json`; TypeScript and TSX share one grammar package, giving twelve required languages. Native runtime modules and grammar bindings are delivered in `vendor/parsers`, outside npm peer resolution. Original upstream package manifests and source archive hashes remain in the distribution provenance. The reduced runtime manifests contain no dependency edges or lifecycle scripts. `node-gyp-build@4.8.4` remains the production prebuild loader.

`tree-sitter-cli@0.23.2` is development-only. Pinned node-gyp/node-addon-api build Kotlin/Dart from the existing generated parser/scanner sources; generation remains available with the development CLI. Required languages fail loudly if a native asset is absent. No fallback compiler runs during consumer installation or loading.

## Before / current local evidence

| Gate | Before audit | Current implementation |
| --- | --- | --- |
| Production lifecycle packages | 17 installed versions / 15 names | 2: ONNX 1.30.0, protobufjs 7.6.6 |
| Production Tree-sitter/grammar/CLI graph edges | Present, conflicting peers and Swift CLI edge | None in actual `pnpm list --prod --depth Infinity --json` |
| Kotlin/Dart | No prebuilds; consumer compiles | N-API 8 prebuilds on all four native targets, built with Node 22.23.3, node-gyp 12.3.0, node-addon-api 7.1.1 |
| macOS ARM64 real parsing | 12/12, with compilation | 12/12 on Node 22.23.3 and 24.21.0 using vendored prebuilds |
| Focused distribution / consumer-policy / pruning / release-policy tests | Existing coverage | Distribution 11/11, consumer harness 8/8, portable pruning 8/8, release policy 9/9 pass at the latest focused checkpoints |
| Build / lint | Qualified packaging baseline | Both pass locally |
| All four native targets | Portable packaging qualified separately | Four native builds and all sixteen npm/pnpm Node 22/24 consumer cases pass |

Exact after logs and graphs are saved under `docs/audits/tree-sitter-implementation-20261009/`. Before logs remain under `docs/audits/tree-sitter-install-20261009/`. These ignored evidence directories contain no committed generated native files. Native build artifacts carry source version/SRI/archive SHA-256 and binary SHA-256; aggregation rechecks them against freshly verified source archives. Each vendored package retains its license files and hashes.

The development build preserves Dart's upstream unused-helper compiler warning; no compiler warning flags or grammar source edits suppress it. Three unsupported upstream linux-arm64 assets (C++, Java, TypeScript) were actually x86-64 and are rejected/omitted; all four advertised target assets remain required. No Linux ARM64 support is claimed by this change.

## Native consumer gate

`.github/workflows/tree-sitter-installation.yml` builds Kotlin/Dart on macOS ARM64/x64, Linux x64 and Windows x64, assembles one universal npm package, verifies all target architectures/checksums/licenses before packing, and tests sixteen clean installations: four platforms × Node 22/24 × npm/pnpm. Each case uses empty node_modules and an isolated empty registry cache/store. A compiler guard rejects build tools, including explicit Windows compiler paths. Actual AST fixtures cover TS, TSX, JS, Python, Java, Kotlin, Go, Rust, Swift, Dart, C and C++.

Untouched package-manager policy is recorded separately. Required approved cases use only ONNX and protobufjs, with version-pinned npm approvals. No wildcard approval, force resolution, legacy peer flag, or global lifecycle disable is used. Peer/compiler/lifecycle-policy/missing-prebuild findings fail the approved gate; other warnings remain classified in raw evidence. A dependency cannot authorize itself for a downstream consumer's policy.

Initial native CI run: [37891926805](https://github.com/caongocquy/code-atlas/actions/runs/37891926805), commit `661b37dccacf55d836241c8f6b42359c28765d62`. All four Kotlin/Dart build jobs succeeded, and aggregation passed provenance/architecture checks. The required actual Linux parser test then caught the upstream Tree-sitter 0.25.1 runtime prebuild requiring `GLIBCXX_3.4.31`, absent on Ubuntu 22.04. Other shipped grammar prebuilds require at most `GLIBCXX_3.4.21`; this failure is isolated to the runtime prebuild. The sixteen consumer cases were skipped because packaging failed; none counts as passing. Raw assembly failure is retained as `assembly-first-run.log`.

Both macOS full-suite comparisons passed with 49 baseline/candidate failures, zero added failures, zero changed assertions and zero new skips. Windows found one new release-policy test failure caused by CRLF line endings; the test now splits both line-ending forms without weakening its assertions. Both Windows suite launcher formats also now escape backslashes correctly for Bash printf. Linux failed runtime loading, so its partial suite is not a valid successful regression comparison.

The fix produces a compatible Linux runtime prebuild from the same integrity-pinned Tree-sitter 0.25.1 archive in native CI. It does not downgrade the runtime or introduce consumer compilation. Native architecture checks alone are insufficient for dynamic-library compatibility; actual loading/parsing remains a mandatory gate. The failed evidence upload also needed `include-hidden-files: true` for generated `.artifact` and `.evidence` directories. The following corrected runs establish actual consumer results and package-size impact; the initial failure is retained.

## Assembled artifact measurements

Corrected native/assembly run [37893836920](https://github.com/caongocquy/code-atlas/actions/runs/37893836920) at `1d6535e3f0bfe6337c392e415c4422d71ae3eaf7` passed all four native builds, actual Linux parser tests, packing and all-target verification. The rebuilt runtime uses GCC/G++ 11.4.0, node-addon-api 8.9.2 and N-API 8; ELF imports require at most GLIBCXX_3.4.29 and GLIBC_2.17, within the tested Ubuntu 22.04 baseline. Older Linux distributions are not qualified by this gate.

| Measurement | Before ordinary npm package | Universal vendored package |
| --- | ---: | ---: |
| Tarball bytes | 489,884 | 21,154,506 |
| Unpacked own package bytes | 2,216,148 | 256,814,063 |

The before package delegated parser assets to separate dependency tarballs. The after package includes them, so these own-package totals do **not** compare total consumer installation footprint. The universal payload retains 41 binding files, 12 node-type files, 67 C/header sources, nine upstream WASM files, 65 native prebuilds and 15 license files, including two header-library licenses. Exact SHA-256 and inventory are saved in `docs/audits/tree-sitter-install-20261009/ci-37893836920-package/checksums.json`; extracted package `verify --all-targets` passes. No generated native payload is committed.

All sixteen consumer jobs in this run failed at package discovery before installation: the upload preserved the `.artifact/` subdirectory, while selection searched only one directory level. Raw logs and explicit `not_started` records remain in `docs/audits/tree-sitter-implementation-20261009/ci-37893836920/consumers/`; there are no install/parser successes to count. The selector now recursively requires exactly one tarball, with a real zero/one/two-file regression test. Source parser and offline-context workflows also prepare the pinned host payload before using ignored vendor assets. The next qualification attempt was [37894782252](https://github.com/caongocquy/code-atlas/actions/runs/37894782252).

## Consumer follow-up evidence

Run [37894782252](https://github.com/caongocquy/code-atlas/actions/runs/37894782252), commit `72f891d3100aa25ab5bf4ef777a766f75ac29884`, reached actual clean installs. All eight approved pnpm cases pass (four platforms x Node 22/24): install and graph exit zero, all twelve AST samples parse, zero compiler invocations, and no peer/compiler/lifecycle-policy/missing-prebuild/deprecation categories. Untouched pnpm defaults still require approval for exactly ONNX and protobufjs; one `ERR_PNPM_IGNORED_BUILDS` report is retained per default case. These diagnostics are explicitly separate from approved consumer gates.

All eight npm cases stopped before installation because the harness assigned one config file to both npm's user and global roles. Raw `manager-version.log` records npm's `double-loading config` error; this is a test-harness setup error. Distinct empty user/global files now preserve isolation, and a regression executes actual `npm --version` against them. The selector test also uses PATH-resolved Bash on Windows rather than a nonexistent `/bin/bash`. Run [37895572907](https://github.com/caongocquy/code-atlas/actions/runs/37895572907), commit `baa7c343e7ee0b855fd502ae140b4053bc6a0fe9`, is the corrected complete rerun. Earlier failed npm installs are not claimed as successes.

The Windows Node 24 harness emits DEP0190 because it passes arguments with `shell: true` to launch package-manager command shims. This is a harness process warning, not a package dependency or a compiler hook; raw logs preserve it. Ordinary package-manager invocation does not use this harness wrapper.

The real universal payload also passed an isolated macOS ARM64 pruning check: parser vendor bytes reduce from 254,574,595 to 31,382,121; host inventory verification and all twelve actual AST fixtures pass. Nine WASM, twelve node-type and fifteen license files remain byte-identical. This check uses a minimal ONNX directory fixture and the parent's pinned loader, so it counts as parser/pruner verification, not a clean installation or ONNX execution smoke.

## Complete consumer evidence

Run [37895572907](https://github.com/caongocquy/code-atlas/actions/runs/37895572907), commit `baa7c343e7ee0b855fd502ae140b4053bc6a0fe9`, passes all sixteen approved clean consumer cases. Every case has install/parser/dependency-graph exit zero, twelve real AST fixtures, zero compiler invocations, and zero peer, compilation, lifecycle-policy, missing-prebuild or deprecation findings. npm default cases pass; Node 24/npm 11 emits five advisory lines identifying exactly two scripts (ONNX 1.30.0 and protobufjs 7.6.6). pnpm default cases report those same two blocked hooks. Approving exactly those hooks clears all dependency warning categories.

Full graphs, lockfiles and raw before/after installation logs are preserved under `docs/audits/tree-sitter-implementation-20261009/ci-37895572907/consumer-artifacts/`; `matrix-summary.json` contains all sixteen actual results. The final tarball in this run is 21,154,571 bytes, SHA-256 `fb280ab58ee499faeb49ee2cd2844a6f40ca5651cbc48f06c28e2c743a330452`; unpacked own-package bytes remain 256,814,063. Source-integrity records are unchanged across rebuilds. macOS/Windows native binary hashes vary across builds, so reproducibility is defined by pinned sources/toolchain plus independently verified output, not promised byte-identical binaries.

The full suite caught one new static contract failure: the offline-context test still expected ubuntu-latest after the required GCC 11 build runner was pinned to Ubuntu 22.04. Its assertion now requires the exact compatible runner, exact Node 22.23.3 preparation, payload preparation before evaluation, and restoration of Node 24 for offline evaluation. Corpus, baseline, offline and fail-fast assertions remain intact. The two targeted Phase15D files pass 13/13. The final source qualification run is [37896677729](https://github.com/caongocquy/code-atlas/actions/runs/37896677729), commit `1d2db007577ed56007312f5ce92e8c7068cf95f5`. All sixteen approved consumers pass again. The separate source-parser workflow [37896677771](https://github.com/caongocquy/code-atlas/actions/runs/37896677771) also passes.

## Final consumer matrix and warning disposition

Run 37896677729 records 32 results: default and reviewed-policy cases for each of sixteen combinations. The approved cases below each pass installation, twelve real AST fixtures, dependency-graph checks and the compiler guard. Raw logs contain no peer, compiler, lifecycle-policy, missing-prebuild, deprecated or engine warnings.

| Native target | npm Node 22 / 24 | pnpm Node 22 / 24 | Actual languages per case | Compiler calls |
| --- | --- | --- | ---: | ---: |
| macOS ARM64 | PASS / PASS | PASS / PASS | 12 / 12 | 0 |
| macOS x64 | PASS / PASS | PASS / PASS | 12 / 12 | 0 |
| Linux x64 | PASS / PASS | PASS / PASS | 12 / 12 | 0 |
| Windows x64 | PASS / PASS | PASS / PASS | 12 / 12 | 0 |

The actual installed production graphs contain zero Tree-sitter/runtime grammar/generator dependency edges. Their only lifecycle packages are `onnxruntime-node@1.30.0` and `protobufjs@7.6.6`, down from seventeen installed hook versions in the authoritative production baseline. The baseline's 257 reachable lock snapshots and the consumer graph's 240 installed identities use different counting domains; they are not a like-for-like total dependency-count reduction.

Default npm 10 cases pass without lifecycle advisories. Default npm 11 cases pass but retain exactly five advisory lines naming the two hooks above. Default pnpm 11 cases exit 1 with `ERR_PNPM_IGNORED_BUILDS` naming those two hooks; parsing is not run in those failed installs. Only reviewed, package-scoped approvals clear those diagnostics. No dependency can approve its own scripts for a downstream root. Exact policy examples are in `PARSER_DISTRIBUTION.md`.

A scan outside the harness classifier found npm 10 verbose `reify failed optional dependency` records for mutually exclusive off-platform `@img/sharp-*` packages (23 per Unix case, 24 on Windows). These are platform filtering, with install exit 0, not compiler/native parser failures; they remain in raw logs. npm 11 and pnpm approved install logs contain none. The Windows Node 24 harness's separate DEP0190 process warning is retained as described above. The pinned Dart scanner's unused-helper warning remains in native build logs, outside consumer installation. No warnings are suppressed.

Before evidence: `docs/audits/tree-sitter-install-20261009/` and the unchanged authoritative audit. Final after evidence: `docs/audits/tree-sitter-implementation-20261009/ci-37896677729/`, including `matrix-summary.json`, per-case `install.log`, parser results, production graphs and consumer lockfiles. The final measured tarball is 21,154,633 bytes (20.17 MiB), SHA-256 `8226d86db627d1fc560a429ad151d2903fd6d35e7d3990cc320e6a4d530b47b6`, with 659 files and 256,814,063 unpacked own-package bytes. Extracted `verify --all-targets` passes for all twelve package records on each advertised target; all source SRI/SHA records match the previous build, and fifteen package licenses plus both build-license entries validate. Exact measurements are in `docs/audits/tree-sitter-install-20261009/ci-37896677729-package/final-measurements.json`. npm installed own-package bytes are 256,814,063. pnpm adds manager metadata: 256,828,649 bytes on macOS, 256,826,829 on Linux, and 256,844,957 on Windows. These are CodeAtlas package-directory sizes, not total dependency/cache/store footprint.

## Application regression gate

Immutable original release baseline: `8f3c2d7671b4d9a9deaa70c83c80c4fccb94689f`. Both checkouts use Node 24.21.0, concurrency 2, equivalent CLI PATH and native runner environment. `compare-release-tests.mjs` compares named failures and normalized assertion details, including tests already failing in the baseline; it also rejects new skips. Passing aggregate counts alone are insufficient.

| Target, run 37896677729 attempt 1 | Baseline pass / fail / skip | Candidate pass / fail / skip | Added / changed / resolved failures | Real SCIP |
| --- | ---: | ---: | ---: | --- |
| macOS ARM64 | 1,297 / 49 / 3 | 1,352 / 49 / 3 | 0 / 0 / 0 | 6/6, no skips |
| macOS x64 | 1,297 / 49 / 3 | 1,352 / 49 / 3 | 0 / 0 / 0 | 6/6, no skips |
| Linux x64 | 1,296 / 50 / 3 | 1,352 / 49 / 3 | 0 / 0 / 1 | 6/6, no skips |
| Windows x64 | 1,233 / 113 / 3 | 1,311 / 90 / 3 | 1 / 0 / 24 | Not run: comparison failed first |

No target adds skips. Linux's one resolved identity is Go fact-extraction determinism: local IDs and Service binding seeds varied in the baseline. The same immutable baseline passed it on prior runs; this is recorded as baseline run variance, not a claimed parser fix. Windows's 24 resolved identities arise from packaging-base CLI path handling already present before this Tree-sitter implementation, not from a new Tree-sitter feature.

Windows's sole added failure is `framework-semantic-fail-fast.test.ts :: fatal framework candidate skips semantic provider and preserves active generation`: `EBUSY` unlinking `atlas.db-wal` during recursive temporary-directory removal, after the assertions. This test, index pipeline and SQLite close implementation have no candidate changes. Two other EBUSY cleanup identities occur in both baseline and candidate. A Windows-only rerun on the exact same SHA did not reproduce this identity, but failed on a different assertion. Attempt 1 remains a failed comparison; the cleanup-lock cause is not claimed fixed.

Windows attempt 2: baseline 1,349 tests (1,232 pass, 114 fail, 3 skip), candidate 1,404 (1,310 pass, 91 fail, 3 skip); comparison has **1 added, 0 changed, 24 resolved, 0 new skips**. Its added identity is `phase17c-b2-graphql.test.ts :: B2 nested-only discovery and unsupported decorator origins remain incomplete`, line 209: namespace-decorator fixture expected one framework entity, received zero. Baseline passes it in that attempt; candidate passes it in attempt 1. The unchanged complete GraphQL fixture file passes 18/18 on local macOS ARM64. Test, facts extractor and framework resolver sources have no implementation diff from the packaging base; this does not prove the Windows difference is unrelated to parser distribution. Cause remains unresolved, so it is an explicit regression-qualification blocker, not dismissed as baseline noise or repaired by changing an assertion. Raw attempt-2 TAP/comparison/exit records are preserved separately in `ci-37896677729/win32-x64-attempt2/`.

Both final Windows attempts stop before the real SCIP smoke because their comparison fails. Earlier corrected run [37893836920](https://github.com/caongocquy/code-atlas/actions/runs/37893836920) ran real SCIP 6/6 with no skips on all four platforms, including Windows, but it does not substitute for unperformed latest-SHA Windows SCIP execution. The final workflow result is **failure**. No rerun result replaces the failed original evidence.

The initial /private/tmp baseline was non-equivalent because it triggered the MCP ephemeral-install guard, so it remains diagnostic only. A corrected durable local baseline/candidate comparison passed with 57/57 failures and zero added/changed failures/new skips; native CI above is the current platform authority. Earlier failed CI runs and their exact harness/runtime causes are retained above rather than replaced by later successes.

Application tests cover semantic indexing/lifecycle and existing framework resolver behavior using real native parser constructors. The targeted JVM/C-family extraction tests pass in package assembly. The real SCIP gate installs pinned `@sourcegraph/scip-typescript@0.4.0` and requires its actual smoke test to run unskipped. Four existing instrumentation tests change only their import to the shipped constructor; their assertions remain unchanged. The release-policy and offline-context assertions now require the new pinned distribution and exact compatible preparation environment, with previous corpus/offline checks preserved.

An independent read-only review of the base-to-candidate diff and final documents found no actionable Critical or Important implementation issue. It inspected archive/artifact trust boundaries, parser constructor wiring, scoped consumer approvals, pruning, assertions and warning handling. Publication payload wiring and the failed Windows comparison remain explicit readiness limits.

## Packaging and preserved work

Portable pruning handles the vendored payload, retaining host native modules, bindings, node-types, WASM and licenses. Inventories are recomputed; source provenance stays intact. The isolated macOS parser/pruner verification described above is not a new four-platform portable ONNX qualification.

Primary and packaging preservation checkpoints have identical HEAD, Git status and hashes for all 337 primary and 49 packaging protected files. Phase 16C/17 work and manifest version 1.6.0 are preserved. Only the isolated task branch is committed/pushed under the user's continued authorization. No merge, tag, publish or release has occurred.

## Remaining release gates and recommendation

**All sixteen consumer installation gates pass with the two explicit reviewed lifecycle approvals. Overall qualification and v1.6.1 publication: NO-GO.**

- Resolve or establish the cause of the Windows GraphQL assertion difference without changing Phase 17 behavior or weakening the test. Re-run equivalent full-suite comparison and latest-SHA real SCIP on Windows. Preserve both failed attempts; neither is a passing regression gate.
- Existing tag publication, release-smoke and portable release workflows still need to consume the same-SHA qualified universal payload. Their fresh checkout cannot pack successfully without preparation: prepack rejects missing targets. The dedicated qualification workflow builds and tests the payload, but this change does not authorize publication.
- Requalify the intended release version after an authorized version change; the tested manifest is still 1.6.0.
- Preserve the separate ordinary npm macOS x64 ONNX native-payload limitation. These parser and semantic fixture gates do not prove a real model provider can load ONNX there. The qualified portable ONNX fix remains on the packaging branch; no runtime feature was removed.
- Hosted compiler images and binaries are recorded and independently hashed, not promised bit-identical across future builds. Ubuntu 22.04 x64 is the Linux baseline; older glibc/libstdc++ environments and Linux ARM64 are unqualified.
