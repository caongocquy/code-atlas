# Release packaging audit (candidate for 1.6.1)

Baseline: immutable `v1.6.0`, commit `8f3c2d7671b4d9a9deaa70c83c80c4fccb94689f`.
Work is isolated from Phase 16C on `chore/release-packaging-161`. The continuation authorizes CLI migration, commit/push and native candidate CI.
No version bump, merge, tag, npm publication, GitHub Release or Homebrew update
is authorized. Historical evidence below is preserved; current continuation
results and decisions are recorded first.

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

Native x64 compilation and actual embedding are still pending a successful CI run;
this is an implemented fix awaiting platform qualification, not a verified x64
success. The native build follows upstream CMake 3.31.8 / Python 3.12 / vcpkg
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
