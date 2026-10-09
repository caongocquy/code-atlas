# Tree-sitter installation reliability implementation

Implementation date: 2026-10-09. Authoritative before baseline: `TREE_SITTER_INSTALL_AUDIT.md` (unchanged). Status: local implementation validated; commit/push authorized by the user; native consumer qualification pending. **NO-GO until the consumer matrix and assertion-level regression gate pass.**

## Distribution change

Tree-sitter 0.25.1 and all eleven grammar package versions/source tarball integrities are pinned in `scripts/parser-sources.json`; TypeScript and TSX share one grammar package, giving twelve required languages. Native runtime modules and grammar bindings are delivered in `vendor/parsers`, outside npm peer resolution. Original upstream package manifests and source archive hashes remain in the distribution provenance. The reduced runtime manifests contain no dependency edges or lifecycle scripts. `node-gyp-build@4.8.4` remains the production prebuild loader.

`tree-sitter-cli@0.23.2` is development-only. Pinned node-gyp/node-addon-api build Kotlin/Dart from the existing generated parser/scanner sources; generation remains available with the development CLI. Required languages fail loudly if a native asset is absent. No fallback compiler runs during consumer installation or loading.

## Before / current local evidence

| Gate | Before audit | Current implementation |
| --- | --- | --- |
| Production lifecycle packages | 17 installed versions / 15 names | 2: ONNX 1.30.0, protobufjs 7.6.6 |
| Production Tree-sitter/grammar/CLI graph edges | Present, conflicting peers and Swift CLI edge | None in actual `pnpm list --prod --depth Infinity --json` |
| Kotlin/Dart | No prebuilds; consumer compiles | macOS ARM64 N-API 8 modules built with Node 22.23.3, node-gyp 12.3.0, node-addon-api 7.1.1 |
| macOS ARM64 real parsing | 12/12, with compilation | 12/12 on Node 22.23.3 and 24.21.0 using vendored prebuilds |
| Focused distribution / consumer-policy / pruning / release-policy tests | Existing coverage | Distribution 8/8, consumer harness 5/5, portable pruning 8/8, release policy 9/9 pass at the latest focused checkpoints |
| Build / lint | Qualified packaging baseline | Both pass locally |
| Other three native targets | Qualified portable packaging, not new distribution | Pending native builds and new consumer gate |

Exact after logs and graphs are saved under `docs/audits/tree-sitter-implementation-20261009/`. Before logs remain under `docs/audits/tree-sitter-install-20261009/`. These ignored evidence directories contain no committed generated native files. Native build artifacts carry source version/SRI/archive SHA-256 and binary SHA-256; aggregation rechecks them against freshly verified source archives. Each vendored package retains its license files and hashes.

The development build preserves Dart's upstream unused-helper compiler warning; no compiler warning flags or grammar source edits suppress it. Three unsupported upstream linux-arm64 assets (C++, Java, TypeScript) were actually x86-64 and are rejected/omitted; all four advertised target assets remain required. No Linux ARM64 support is claimed by this change.

## Native consumer gate

`.github/workflows/tree-sitter-installation.yml` builds Kotlin/Dart on macOS ARM64/x64, Linux x64 and Windows x64, assembles one universal npm package, verifies all target architectures/checksums/licenses before packing, and tests sixteen clean installations: four platforms × Node 22/24 × npm/pnpm. Each case uses empty node_modules and an isolated empty registry cache/store. A compiler guard rejects build tools, including explicit Windows compiler paths. Actual AST fixtures cover TS, TSX, JS, Python, Java, Kotlin, Go, Rust, Swift, Dart, C and C++.

Untouched package-manager policy is recorded separately. Required approved cases use only ONNX and protobufjs, with version-pinned npm approvals. No wildcard approval, force resolution, legacy peer flag, or global lifecycle disable is used. Peer/compiler/lifecycle-policy/missing-prebuild findings fail the approved gate; other warnings remain classified in raw evidence. A dependency cannot authorize itself for a downstream consumer's policy.

CI run URLs, native parser results, clean install logs and universal package size are pending the first branch push; no cross-platform success is claimed here.

## Application regression gate

The full suite is compared with immutable original release commit `8f3c2d7671b4d9a9deaa70c83c80c4fccb94689f`, using equivalent Node 24.21.0, concurrency 2, CLI PATH and durable checkout locations. The first diagnostic baseline lived in /private/tmp and triggered the MCP ephemeral-install guard; its logs are retained, but that non-equivalent comparison is not the release gate. The corrected durable baseline finished: 1,349 tests, 1,289 pass, 57 fail, 3 skipped. Its comparison with the first candidate run found zero changed assertions and zero resolved failures; the one added failure was the obsolete policy test, now updated to verify the new required distribution. The final candidate suite finished with 1,398 tests, 1,338 pass, 57 fail and 3 skipped. The assertion-level comparison passes: zero added failures, zero changed failure assertions and zero new skips. Existing assertions remain unchanged except the release-policy test now requires vendored grammar delivery and the minimal script policy; parser instrumentation imports the actual production constructor.

Actual local parser fixtures, JVM/C-family tests, semantic lifecycle/indexing, SCIP and framework resolver targeted checks ran. The broader 65-test diagnostic has 60 pass, 4 known facts assertion failures and one optional real SCIP skip; a separate run with pinned real scip-typescript 0.4.0 subsequently passes 6/6, zero skipped; these failures match the final equivalent baseline; they are not treated as passing tests. Full native suite comparisons also report changed assertions in previously failing tests and new skips.

## Packaging and preserved work

Portable pruning now handles CodeAtlas's vendored parser payload, retaining the current target native modules, bindings, node-types, WASM and licenses. Pruned distribution inventories are recomputed so checksums/coverage remain truthful; original source provenance remains intact. Primary dirty checkout and packaging branch preservation checks pass: identical HEAD, status and protected hashes (337 primary files, 49 packaging files). Phase 16C/17 work and package version are preserved. No merge, tag, publish or release action is authorized by this implementation.

## Remaining release gates

- Complete all four native artifacts and sixteen clean npm/pnpm consumer cases.
- Complete equivalent original-release full-suite comparisons, with zero new failures or changed existing failure assertions.
- Record actual package-size delta and warning categories from installed artifacts.
- Review existing release workflow integration before any later publication; generated universal parser payload is a mandatory packaging prerequisite.
- Keep the known upstream macOS x64 ordinary ONNX payload issue separate from Tree-sitter qualification; the existing portable ONNX fix remains on the preserved packaging branch.
