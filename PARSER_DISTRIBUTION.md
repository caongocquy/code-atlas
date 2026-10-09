# Native parser distribution

CodeAtlas vendors Tree-sitter 0.25.1 and the 11 grammar package versions pinned in `scripts/parser-sources.json`. The SHA-512 values come from the production importer in `docs/audits/tree-sitter-install-20261009/source-pnpm-lock.yaml`. The builder downloads each npm tarball directly, checks its SRI before extraction, and records both its source SHA-256 and every delivered file SHA-256 in `vendor/parsers/parser-distribution.json`.

Vendored package files retain their JavaScript bindings, types, node-type data, grammar source, queries, WASM assets, and license files. The installed `package.json` is reduced to runtime entry metadata; original package metadata is kept in the distribution manifest as provenance, outside npm's package dependency graph. Existing upstream prebuilds are copied from their pinned tarballs and their ELF, Mach-O, or PE machine type is checked against the directory tuple.

The runtime and ten grammar packages declare MIT; `@driftlog/tree-sitter-dart` declares ISC. Every package's top-level `LICENSE` file and hash is recorded, and verification fails if either the asset or its record is missing. Native modules also embed headers from `node-addon-api@7.1.1` and `8.9.2`; their original MIT `LICENSE.md` files are copied into `vendor/parsers/BUILD_LICENSES/` and hashed in `distribution.build.licenseFiles`, so no build-time package is needed at runtime. Three pinned archives contain x86-64 binaries incorrectly labelled `linux-arm64` (C++, Java, and TypeScript); those invalid optional prebuilds are omitted. A mismatch for any advertised target stops preparation.

Kotlin 0.3.8 and Dart 1.0.4 have no upstream prebuilds. `prepare --build-missing` compiles these packages on the current native runner with `node-gyp@12.3.0`, `node-addon-api@7.1.1`, Node 22.23.3 headers in CI, and N-API 8. It uses checked-in parser/scanner sources and never invokes the Tree-sitter generator. Linux x64 also rebuilds the exact pinned `tree-sitter@0.25.1` runtime: its upstream binary requires `GLIBCXX_3.4.31`, which Ubuntu 22.04 does not provide. This build resolves `node-addon-api@8.9.2` through the installed pinned runtime package and pins `/usr/bin/gcc-11` plus `/usr/bin/g++-11`; it replaces only the runtime's Linux x64 upstream prebuild. The artifact manifest records each binary's addon-api version, and the runtime entry records both compiler versions and the Ubuntu 22.04 baseline. Generated `napi.node` files are installed under each package's `prebuilds/<platform>-<arch>/` directory.

The native job artifact is `.parser-build/<platform>-<arch>/`: macOS and Windows contain Kotlin, Dart, and `manifest.json`; Linux x64 additionally contains `tree-sitter-runtime.node`. The manifest records target, source provenance, per-binary build dependency, toolchain, and SHA-256 values.

Native CI builds each advertised target on its matching runner:

```sh
node scripts/parser-distribution.mjs prepare --build-missing
```

Upload the target folder from each run as `parser-prebuild-<platform>-<arch>`. The native artifact manifest records each binary's SHA-256 together with its grammar name, version, registry SRI, and source-archive SHA-256. In an aggregation job, download the four artifacts into `.parser-build/<platform>-<arch>/`, then run:

```sh
node scripts/parser-distribution.mjs prepare --prebuild-input .parser-build
node scripts/parser-distribution.mjs verify --all-targets
```

The aggregate command downloads and checks the same pinned source archives, preserves valid upstream prebuilds, applies the eight Kotlin/Dart binaries, and replaces the incompatible Linux x64 runtime binary with its rebuilt N-API module. It refuses missing tuples, missing Linux runtime output, extra files, checksum mismatches, incompatible build settings, or binaries whose machine architecture disagrees with their tuple. Do not run `--build-missing` on a cross-target job; the builder only compiles for its current OS and CPU.

`verify` checks package provenance, exact file inventories and checksums, binary formats, and native prebuild coverage for the current host. On Linux it also requires the runtime package to contain only the generated N-API module for linux-x64. `verify --all-targets` additionally requires Kotlin and Dart N-API prebuilds for `darwin-arm64`, `darwin-x64`, `linux-x64`, and `win32-x64`, plus the rebuilt Tree-sitter runtime N-API prebuild for linux-x64. The native consumer matrix parses all 12 languages on Node 22 and Node 24; `verify` checks binary structure and coverage, not parser behavior.
