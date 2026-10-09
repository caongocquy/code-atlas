# Tree-sitter installation reliability audit

Audit date: 2026-10-09. Status: diagnosis and tested lifecycle-policy remediation complete; dependency/prebuild remediation is recommended, not implemented.

## Conclusion

The warnings have separate causes: incompatible declared peer ranges, missing Kotlin/Dart prebuilds, Swift's unnecessary production CLI dependency, and package-manager lifecycle approvals. Four green portable jobs do not establish that ordinary npm/pnpm installs are warning-free or toolchain-free.

Keep the current grammar versions and Tree-sitter 0.25.1. For v1.6.1, document and test package-scoped lifecycle approvals, disclose the Kotlin/Dart toolchain requirement for ordinary npm installs, and retain the qualified portable installer. Do not claim a warning-free or toolchain-free npm/pnpm release. If that is a v1.6.1 acceptance requirement, the npm distribution is NO-GO until the prebuild/metadata work below is complete. The already-qualified portable distribution remains GO for parser execution on its four tested targets.

## Isolation and provenance

- Audit branch: `chore/tree-sitter-install-reliability`, based on `0f73215b528005af5b95c5477f521d0aeb17561c`.
- Qualified production code: `5f91d12fc98bd0c2291192721790574231061abc`; the subsequent base commit is audit-only.
- Packaging branch, primary dirty checkout, and Phase 17 files were not modified.
- Candidate manifest remains version 1.6.0, as in the packaging candidate. No version bump, publish, tag, release, commit, push, or PR.
- Actual pnpm lockfile SHA-256: `8246d1e3a8d2ae38acc74bd1e2b7e3cc6b570a19f44232097e19275624d9992d`.
- `pnpm-lock.yaml` is a multi-document YAML stream. The production traversal uses the root importer with CodeAtlas's grammar dependencies, not the earlier Inspector-client importer. 257 production-reachable snapshots include platform-filtered optional packages; 17 distinct installed package versions have lifecycle hooks, across 15 package names.
- npm does not consume `pnpm-lock.yaml`. Source npm reproduction resolves the unchanged manifest. Tarball consumers resolve their own dependency tree; their captured npm lockfiles are the authority for those cases.
- The npm tarball uses the qualified packaging worktree's compiled `dist`, copied into scratch. Tarball SHA/integrity/file inventory are in `before-pack-result.json`; parser sources were not changed.

## Reproduction environment and exact commands

Host: macOS Darwin 25.6.0, ARM64. Official Node archives were checked against Node's SHASUMS256.

| Runtime | Bundled npm | pnpm |
| --- | --- | --- |
| Node 22.23.3 | 10.9.9 | 11.22.0 |
| Node 24.21.0 | 11.19.0 | 11.22.0 |

The first source and consumer attempts each used a new directory, empty `node_modules`, separate empty npm cache or pnpm store, and an empty user npmrc. No `--force`, `--legacy-peer-deps`, `--ignore-scripts`, global script opt-out, wildcard approval, or warning filter was used. npm's `--no-audit` avoids an unrelated network security audit; warnings and foreground script output remain intact. Logs combine stdout/stderr without filtering.

```sh
# Source: unchanged manifests and the actual pnpm lockfile/workspace policy
npm install --omit=dev --foreground-scripts --loglevel=verbose --no-audit --no-fund --cache CASE/npm-cache
pnpm install --prod --frozen-lockfile --reporter=append-only --store-dir CASE/pnpm-store

# Consumer: a private package depending on the freshly packed local CodeAtlas tarball
npm install --foreground-scripts --loglevel=verbose --no-audit --no-fund --cache CASE/npm-cache
pnpm install --reporter=append-only --store-dir CASE/pnpm-store
```

Absolute executable paths, versions, duration and exit code are recorded in each `result.json`. pnpm was invoked through Corepack with the requested Node executable. Corepack's message about adding `packageManager` is consumer harness metadata, not a grammar build failure.

## Before results

| Clean case | Node 22 | Node 24 | Runtime result |
| --- | --- | --- | --- |
| Source npm | exit 1, 7.63 s | exit 1, 8.46 s | resolver stops before install; parsers not tested in these incomplete installs |
| Source pnpm, repository approvals | exit 0, 281.72 s | exit 0, 251.82 s | 12/12 languages parse on both |
| Tarball consumer npm, default policy | exit 0, 172.42 s | exit 0, 172.67 s | 12/12 languages parse on both |
| Tarball consumer pnpm, default policy | exit 1, 271.26 s | exit 1, 267.24 s | ONNX fetch timeout before lifecycle; not classified as parser regression |

The failed pnpm consumer attempts are retained. ONNX's 113,507,888-byte registry tarball was subsequently downloaded directly and its SHA-512 matched the actual source lockfile. An attempted offline store recovery still reported `ERR_PNPM_NO_OFFLINE_TARBALL`: importing a local archive did not populate the registry cache identity. This recovery is NOT a successful clean consumer install and is not counted as one.

To isolate lifecycle behavior from that transport failure, two additional installs used empty `node_modules`, the frozen production lockfile and cached registry downloads, with `sideEffectsCache: false`. Removing only the root `allowBuilds` configuration caused `ERR_PNPM_IGNORED_BUILDS` on Node 22 and 24; importing the parser then failed at Kotlin. These are controlled diagnostics, not cold-cache results.

## Exact warning → dependency → root cause

| Exact observed text or behavior | Category | Dependency path and cause | Disposition |
| --- | --- | --- | --- |
| `npm error ERESOLVE unable to resolve dependency tree`; `peer tree-sitter@"^0.21.0" from tree-sitter-kotlin@0.3.8` | Peer conflict, fatal in source install | CodeAtlas → Kotlin 0.3.8 versus root Tree-sitter 0.25.1 | Fix published peer metadata with demonstrated compatibility; do not force resolution |
| `npm warn ERESOLVE overriding peer dependency` | Peer conflicts in tarball consumer | CPP ^0.21.1, Java ^0.21.1, Kotlin ^0.21.0, TypeScript ^0.21.0, nested C 0.23.6 ^0.22.1; an additional npm explanatory logger failure obscures one warning block | Installed parsing succeeds, but metadata remains inconsistent; exact blocks are in raw logs |
| `[ERR_PNPM_IGNORED_BUILDS] Ignored build scripts: ...` (17 package versions) | Blocked lifecycle scripts | Consumer root has no `allowBuilds`; CodeAtlas's repository policy is not inherited by consumers | Explicit reviewed per-package approvals restore installation; do not disable the guard |
| `No native build was found for platform=darwin arch=arm64 ...` at `tree-sitter-kotlin/.../node-gyp-build.js` | Missing prebuilt binary / runtime failure after blocked builds | Kotlin 0.3.8 has no published `prebuilds`; static imports prevent the entire parser registry loading. Dart also has no prebuild | Supply real tested prebuilds for both; do not make languages silently optional |
| `gyp info using node-gyp@12.3.0`; `CXX(target) ...binding.o`, `CC(target) ...parser.o` | Native compilation | Kotlin 0.3.8 and @driftlog/Dart 1.0.4 use `node-gyp-build` and have no matching prebuild at all | Currently requires Python/C++ toolchain; supply prebuilds rather than requiring user compilation |
| `../src/scanner.c:21:13: warning: unused function 'skip' [-Wunused-function]`; `1 warning generated.` | Compiler warning | @driftlog/tree-sitter-dart 1.0.4 → upstream scanner declares an unused static helper | Fix scanner upstream or ship validated prebuilds; do not add warning-suppression flags |
| `Downloading https://github.com/tree-sitter/tree-sitter/releases/download/v0.23.2/tree-sitter-macos-arm64.gz` | Build-only production download | CodeAtlas → Swift 0.7.1 → tree-sitter-cli 0.23.2 → `install.js` | Runtime does not need generator; remove this edge in the shipped runtime distribution |
| `npm warn install-scripts 18 packages have install scripts not yet covered by allowScripts:` | npm 11 lifecycle-policy advisory | 17 locked lifecycle package versions plus a second peer-resolved Tree-sitter 0.22.4 in npm's consumer tree | npm 11.19 runs scripts in these logs; explicit pinned approvals remove advisory. This is not evidence they were blocked |
| `[WARN] GET .../onnxruntime-node-1.30.0.tgz error (23)`; `[23] The operation was aborted due to timeout` | Network/download, outside grammar warning categories | CodeAtlas → Transformers 4.3.0 → ONNX Runtime 1.30.0; large tarball exceeded fetch timeout | Preserve failed result; source pnpm installs completed and direct download integrity verified |
| `[WARN] Tarball download average speed ... is below 50 KiB/s`, `[WARN] Request took ...ms` | Network performance | Several registry downloads, including grammar tarballs | No dependency or parser failure inferred from these warnings |
| No `npm warn deprecated ...` observed | Deprecated package category | None emitted by these production installation attempts | No speculative upgrade or removal warranted |
| Platform-filtered `@img/sharp-*` optional packages; no failed optional package warning observed | Optional dependencies | Transformers → sharp → OS/CPU-specific binary packages | Expected platform filtering; not missing Tree-sitter grammars |

Additional declarations from the actual lockfile also mismatch runtime 0.25.1: direct C 0.24.1 (^0.22.4), Rust 0.24.0 (^0.22.1), Swift 0.7.1 (^0.22.1), and nested JS 0.23.1 (^0.21.1). Optional peer declarations do not mean the grammar itself is optional. Fresh frozen pnpm installs do not re-report all peer mismatches, so silence there is not proof of compatible metadata. Go/Python/JS 0.25 legitimately require the 0.25 runtime; downgrading everything to 0.21 would create new conflicts.

## Production lifecycle inventory from the lockfile

The inventory below is obtained by traversing root production `dependencies` and `optionalDependencies` in lock snapshots, then checking the actual installed manifests. It excludes Inspector and esbuild development hooks. Prebuild presence describes published file coverage; actual host load/parse tests provide runtime proof.

| Package | Shortest production path | Hook | Published prebuild coverage |
| --- | --- | --- | --- |
| `@driftlog/tree-sitter-dart@1.0.4` | `@driftlog/tree-sitter-dart` | `node-gyp-build` | none |
| `tree-sitter@0.25.1` | `tree-sitter` | `node-gyp-build` | darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-arm64, win32-x64 |
| `tree-sitter-c@0.24.1` | `tree-sitter-c` | `node-gyp-build` | darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-arm64, win32-x64 |
| `tree-sitter-cpp@0.23.4` | `tree-sitter-cpp` | `node-gyp-build` | darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-arm64, win32-x64 |
| `tree-sitter-go@0.25.0` | `tree-sitter-go` | `node-gyp-build` | darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-arm64, win32-x64 |
| `tree-sitter-java@0.23.5` | `tree-sitter-java` | `node-gyp-build` | darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-arm64, win32-x64 |
| `tree-sitter-javascript@0.25.0` | `tree-sitter-javascript` | `node-gyp-build` | darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-arm64, win32-x64 |
| `tree-sitter-kotlin@0.3.8` | `tree-sitter-kotlin` | `node-gyp-build` | none |
| `tree-sitter-python@0.25.0` | `tree-sitter-python` | `node-gyp-build` | darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-arm64, win32-x64 |
| `tree-sitter-rust@0.24.0` | `tree-sitter-rust` | `node-gyp-build` | darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-arm64, win32-x64 |
| `tree-sitter-swift@0.7.1` | `tree-sitter-swift` | `node-gyp-build` | darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-arm64, win32-x64 |
| `tree-sitter-typescript@0.23.2` | `tree-sitter-typescript` | `node-gyp-build` | darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-arm64, win32-x64 |
| `onnxruntime-node@1.30.0` | `@huggingface/transformers` → `onnxruntime-node` | `node ./script/install` | native payload under bin/napi-v6; not node-gyp prebuilds |
| `tree-sitter-c@0.23.6` | `tree-sitter-cpp` → `tree-sitter-c` | `node-gyp-build` | darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-arm64, win32-x64 |
| `tree-sitter-cli@0.23.2` | `tree-sitter-swift` → `tree-sitter-cli` | `node install.js` | none |
| `tree-sitter-javascript@0.23.1` | `tree-sitter-typescript` → `tree-sitter-javascript` | `node-gyp-build` | darwin-arm64, darwin-x64, linux-arm64, linux-x64, win32-arm64, win32-x64 |
| `protobufjs@7.6.6` | `@huggingface/transformers` → `onnxruntime-web` → `protobufjs` | `node scripts/postinstall` | none |

ONNX ships N-API payloads outside a `prebuilds/` directory; absence of that directory does not imply compilation. Its postinstall can acquire extra accelerator libraries on Linux. protobufjs's postinstall checks dependent version schemes; it is not a native compiler. sharp 0.35.4 is in the installed production tree but declares no install/postinstall hook. `node-addon-api` supplies headers and has no production lifecycle hook. Swift's `which` edge is build tooling too; verify upstream usage before removing it, rather than treating every dependency as runtime-needed.

Swift's `binding.gyp` consumes existing `src/parser.c`, `src/scanner.c` and the Node binding; it never invokes `tree-sitter-cli`. The packaging branch already repacks integrity-pinned Swift 0.7.1 with only that CLI edge removed and checks that non-manifest assets are unchanged. That install-only override applies to portable bundle construction; it is absent from the ordinary npm tarball, hence the consumer still downloads the CLI. A root override or pnpm patch alone would not automatically fix every downstream npm consumer.

## After: reviewed lifecycle policy

The after cases change only consumer/root approval configuration. They do not change dependency versions, grammar sources, parser behavior or compilation flags.

- pnpm: frozen root production dependency tree, new `node_modules`, cached downloads, `sideEffectsCache: false`, and explicit `allowBuilds: true` for the 15 audited production hook names. No wildcard or dangerous allow-all option.
- npm: new consumer `node_modules`, original captured npm lockfile and registry cache, `npm ci`, and `package.json.allowScripts` pinned to the 18 actual hook package versions in that consumer tree. npm 10 ignores this newer policy field; npm 11 removes its policy advisory.
- Cached downloads make the before/after diagnostic faster; these durations are not installation performance benchmarks or proof that cold network fetches were fixed.

| After case | Install exit | Parser result | Remaining warnings |
| --- | --- | --- | --- |
| npm / Node 22 | 0, 50.27 s | 12/12 pass | 6 peer warning blocks; Dart compiler warning |
| npm / Node 24 | 0, 50.95 s | 12/12 pass | 1 peer warning block in this npm ci run; Dart compiler warning |
| pnpm / Node 22 | 0, 53.26 s | 12/12 pass | Dart compiler warning; Kotlin/Dart still compile |
| pnpm / Node 24 | 0, 53.95 s | 12/12 pass | Dart compiler warning; Kotlin/Dart still compile |

Peer warning counts vary between npm install and npm ci and between npm versions. They do not demonstrate repaired metadata. Swift CLI still downloads in all ordinary approved installs. The 17 blocked-build errors and npm 11 policy advisory are resolved by package-specific approval; the other causes are explicitly unresolved.

Consumers can use `pnpm approve-builds` to review the reported packages, then commit their root policy. With npm 11, `npm install-scripts ls` and `npm install-scripts approve <reviewed-package>` write pinned approvals. Global/npm-exec installations have a different policy entry point; a dependency cannot grant itself permission by publishing `allowScripts` in its own manifest.

## Comparison with reference projects

The published tarballs were inspected, rather than assuming their current repository manifests describe what users receive. No clean reference install was performed; no warning-free claim is made about either reference.

| Aspect | CodeAtlas candidate | GitNexus 1.6.12 published package | CodeGraph 1.6.2 published package |
| --- | --- | --- | --- |
| Parser strategy | Node native Tree-sitter 0.25.1 + registry grammar packages | Native Tree-sitter 0.21.1 + standard registry grammars and vendored grammar bindings | Published root is a thin shim; application ships in per-platform bundles; source manifest uses web-tree-sitter and WASM assets |
| Prebuild strategy | Most grammars have 6 tuples; Kotlin/Dart none | 51 vendored prebuild paths across C/ObjC/Dart/Proto/Swift/Kotlin/Zig; postinstall prefers these in place under vendor | 6 OS/CPU-filtered optional platform packages, with bundled Node/runtime/application |
| Failure behavior | Required static imports fail when Kotlin/Dart binary absent | Postinstall catches build failures, warns that a language is unavailable, always exits 0; some vendored languages optional | Missing optional platform bundle triggers runtime GitHub-release download/cache fallback; install success alone is insufficient |
| Optional native/model strategy | Grammar support required; Transformers is direct production dependency | Published tarball lists Transformers and ONNX as optional dependencies (repository main differs) | Platform packages optional for OS/CPU selection; missing matching package makes command depend on fallback download |
| Maintenance tradeoff | Small loader, but upstream peer/build defects reach consumer install | Vendors pinned binaries/licenses and fallback source build; cannot copy silent language loss | Larger self-contained platform bundles; portable engine/source uses WASM; changing CodeAtlas to this architecture is unnecessary for a patch release |

CodeGraph's selected macOS ARM64 platform package advertises `os: [darwin]`, `cpu: [arm64]`, 293,125,972 unpacked bytes and no install scripts in registry metadata. Its shim passes `--liftoff-only` for WASM stability and contains an explicit missing-bundle network fallback. It is not evidence that a Rust parser migration is necessary. GitNexus's vendored fallback can invoke `npx node-gyp rebuild`; approved postinstall and matching prebuild coverage still matter.

Primary references:

- [GitNexus official postinstall strategy](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/scripts/build-tree-sitter-grammars.cjs)
- [GitNexus official package manifest](https://github.com/abhigyanpatwari/GitNexus/blob/main/gitnexus/package.json) — published tarball metadata in the evidence is authoritative for 1.6.12.
- [CodeGraph official source manifest](https://github.com/colbymchenry/codegraph/blob/main/package.json) — published shim manifest/archive was inspected separately.
- [pnpm build policy](https://pnpm.io/settings/build) — conclusions for 11.22.0 are based on the reproduced behavior, not newer documentation defaults.
- [npm lifecycle approvals](https://docs.npmjs.com/cli/v11/commands/npm-install-scripts/) and [npm 11 migration warnings](https://github.blog/changelog/2026-06-09-upcoming-breaking-changes-for-npm-v12/) — actual 11.19 logs demonstrate advisory behavior.

## Recommended dependency/build changes

1. Keep pinned runtime 0.25.1 and current grammar source revisions. Document the tested package-scoped approvals and ordinary-install toolchain requirement immediately. Source contributors should use the declared `pnpm@11.22.0` and repository policy until peer metadata is repaired.
2. Extend the existing integrity-checked Swift runtime repack to the distribution consumed by ordinary npm users, or consume an upstream fixed release with equivalent grammar assets. Remove CLI from the shipped runtime graph; retain it only where parser generation runs. Do not delete the hook that selects a native prebuild.
3. Supply Kotlin 0.3.8 and @driftlog/Dart 1.0.4 N-API prebuilds for the four advertised targets, produced from exact existing sources in native CI, with checksums/licenses and actual parsing on Node 22/24. Retain already-shipped prebuilds for other grammars. Do not copy GitNexus binaries unless source, binding ABI and licensing are independently verified.
4. Repair invalid peer metadata through upstream releases where possible. If ownership is necessary, a single pinned vendored parser payload is simpler than maintaining unrelated published forks: keep runtime and grammars outside npm's peer-resolution graph, include existing JS binding files and all target prebuilds, and keep generator/compiler packages build-only. No language is optional. Fail package validation when any required tuple is absent. This is a follow-up implementation, not a claim that the current tarball is fixed.
5. Add a clean consumer install gate for npm/pnpm and Node 22/24 on macOS ARM64/x64, Linux x64 and Windows x64. Test default-policy behavior and reviewed explicit policy separately, retain full logs, and assert all 12 language fixtures parse with no ERROR/MISSING nodes. For prebuilt delivery, verify parsing without calling compiler tools. Run semantic/framework fixtures before accepting any grammar asset/version change.

Do not use `--legacy-peer-deps`, downgrade the shared runtime, approve all scripts globally, remove required language support, or move every parser to WASM solely to reduce installer warnings. Per-package approvals resolve authorization, not a missing prebuilt asset or peer metadata mismatch.

## Runtime parser verification

Fresh local verification uses the compiled installed `parseSource`, not package import alone. Each of TS, TSX, JS, Python, Java, Kotlin, Go, Rust, Swift, Dart, C and C++ parses a real valid source fixture and asserts `rootNode.hasError === false`; unsupported `.txt` returns undefined. All enabled source/consumer npm and policy-remediated installs above pass 12/12.

Native cross-platform evidence is the already-completed packaging run, re-verified by GitHub API during this audit:

[Qualified native run 37872719908](https://github.com/caongocquy/code-atlas/actions/runs/37872719908), SHA `5f91d12fc98bd0c2291192721790574231061abc`, all jobs successful. The audited branch has identical production parser code and dependency lock.

| Native runner | Runtime | Installed artifact | Extracted artifact |
| --- | --- | --- | --- |
| macOS ARM64 (`macos-15`) | Node 24.21.0 | all 12 parse, pass | all 12 parse, pass |
| macOS x64 (`macos-15-intel`) | Node 24.21.0 | all 12 parse, pass | all 12 parse, pass |
| Linux x64 (`ubuntu-22.04`) | Node 24.21.0 | all 12 parse, pass | all 12 parse, pass |
| Windows x64 (`windows-2022`) | Node 24.21.0 | all 12 parse, pass | all 12 parse, pass |

These tests execute `native parsers load every supported language from the artifact` in `scripts/smoke-release-bundle.mjs`, checking actual syntax trees. They validate compiled portable artifacts, not default npm/pnpm consumer approval behavior. No new native CI run was needed or claimed for this documentation-only audit. Node 22 parser verification on Linux/Windows, fresh npm/pnpm consumer installs there, and a toolchain-free ordinary npm package remain unverified. The separate Phase14B parser workflow is Linux-only, not a four-platform matrix.

## Release disposition

| Finding | v1.6.1 decision |
| --- | --- |
| Missing lifecycle approvals in consumers | Document/test before npm/pnpm release; current repo policy does not propagate |
| Swift downloads build-only CLI in ordinary npm tree | Fix before claiming optimized/reliable ordinary npm delivery; portable fix already qualified |
| Kotlin/Dart need user compilation | May defer binary distribution work only with explicit toolchain requirement and qualified portable alternative; blocks a toolchain-free npm/pnpm claim |
| Source npm ERESOLVE and consumer peer warnings | Existing metadata issue; supported source pnpm works. Repair before claiming clean npm source installs; do not suppress |
| Dart unused helper warning | Upstream scanner cleanup can defer if compilation and parsing succeed; not a runtime parser regression |
| ONNX cold consumer fetch timeout | Environment/download failure retained; no false green for those attempts. Full clean consumer matrix still needed for installation reliability gate |

The current ordinary npm/pnpm distribution is **NO-GO for a clean/toolchain-free installation guarantee**. This audit does not revoke the four-platform portable parser qualification. Shipping v1.6.1 as previously qualified portable artifacts is unaffected by these unchanged parser dependencies; broader npm installation reliability is not established by that green matrix.

## Evidence and remaining work

Raw before/after logs, exact command results, pinned approval policies, production lifecycle traversal, source and consumer lockfiles, parser fixture probe, registry pack metadata and the native CI log are saved under `docs/audits/tree-sitter-install-20261009/` in this isolated worktree. The folder is ignored by repository policy; the concise root audit document is the reviewable change. No cache, model, generated database or native binary was copied there.

`results.json` summarizes the observations; each case's `install.log` remains authoritative. Failed consumer retries are not substituted for the original cold failure. No full application suite was rerun: no production/runtime/test/config files were modified. Proposed vendoring/prebuild changes, reference clean installs, and additional native consumer matrix results are not implemented or claimed.
