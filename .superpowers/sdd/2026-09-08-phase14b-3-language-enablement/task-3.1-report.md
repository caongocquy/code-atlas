# Task 3.1 native grammar and packaging report

Date: 2026-09-08
Base HEAD: `65ac887`
Host: macOS arm64, Node `v22.23.2`, tree-sitter runtime `0.25.1`

## Exact runtime dependencies

| Language | npm package | Version | Grammar metadata |
|---|---|---:|---:|
| Python | `tree-sitter-python` | `0.25.0` | `tree-sitter-python@0.25.0` |
| Java | `tree-sitter-java` | `0.23.5` | `tree-sitter-java@0.23.5` |
| Kotlin | `tree-sitter-kotlin` | `0.3.8` | `tree-sitter-kotlin@0.3.8` |
| Go | `tree-sitter-go` | `0.25.0` | `tree-sitter-go@0.25.0` |
| Rust | `tree-sitter-rust` | `0.24.0` | `tree-sitter-rust@0.24.0` |
| Swift | `tree-sitter-swift` | `0.7.1` | `tree-sitter-swift@0.7.1` |
| Dart | `@driftlog/tree-sitter-dart` | `1.0.4` | `tree-sitter-dart@1.0.4` |
| C | `tree-sitter-c` | `0.24.1` | `tree-sitter-c@0.24.1` |
| C++ | `tree-sitter-cpp` | `0.23.4` | `tree-sitter-cpp@0.23.4` |

All nine packages are regular runtime dependencies and are pinned exactly in
`package.json` and `pnpm-lock.yaml`. The existing `tree-sitter@^0.25.1`,
JavaScript, and TypeScript dependencies remain unchanged. No second parser
runtime, WASM fallback, or project postinstall was added.

## ABI/native load result

`node --input-type=module` loaded each package, passed its grammar to the
single `tree-sitter@0.25.1` `Parser`, and parsed an empty source successfully:

```text
python ok
java ok
kotlin ok
go ok
rust ok
swift ok
dart ok
c ok
cpp ok
```

The same native load check passed after the package was installed from the
packed artifact on this Node 22/macOS arm64 host.

## Packed artifact result

`./node_modules/.bin/tsc && ./node_modules/.bin/vite build --config web/vite.config.ts`
passed. `pnpm pack --pack-destination <TMP>/phase14b-pack` produced
`code-atlas-1.0.0.tgz`. The tarball contains `dist/**`, `package.json`, and
`README.md`; its package metadata contains the nine exact grammar dependencies,
the existing scripts only, and no `postinstall`.

An isolated install of that tarball at
`<TMP>/phase14b-packed-smoke` passed native parsing for all nine target
languages with the exact package identities above. No WASM artifact or parser
substitution was used.

Linux x64 coverage is provided by
`.github/workflows/phase14b-parser-platform.yml`; it runs Node 22, frozen
installation, build, and the focused packaging test.
