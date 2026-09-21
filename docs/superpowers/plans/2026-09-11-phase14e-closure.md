# Phase 14E Closure

Status: CLOSED + RELEASE-HARDENING-READY

## Scope

Phase14E is presentation-only. No Phase15 work or graph, indexing, resolver,
framework, reliability, JSON-schema, or exit-code changes were introduced.

Implementation commits:

- `e5a5bce` — `feat(cli): add shared presentation primitives`
- `73cca8b` — `feat(cli): apply terminal-aware presentation`
- `f2394b3` — `feat(cli): polish command result output`
- `57be847` — `fix(cli): preserve status heading`

Final implementation HEAD: `57be847ae0a063b388a07d3db53a53c5716a473f`.

The design/spec commit was `0e3fa2d`.

## Changes

- Added `picocolors@1.1.1` as a direct dependency.
- Added shared terminal capability and presentation primitives.
- CI, non-TTY, and `NO_COLOR` output remains deterministic and ANSI-free.
- TTY output supports color and interactive progress.
- JSON output bypasses human presentation.
- Packed human `init` and `status` exercise the migrated renderer.
- MCP stdout remains protocol-only.

Terminal semantics are:

- `CI === "true"` disables color and interactive rendering, including under a
  pseudo-TTY.
- Presence of `NO_COLOR`, including `NO_COLOR=""`, disables color.

## Verification

- Focused CLI/regression: 28/28 pass.
- Phase14C/D aggregate: 188 pass, 0 fail, 1 skip.
- Full suite: 622 total, 608 pass, 12 accepted historical failures, 2 skip.
- ESLint: pass.
- UI typecheck: pass.
- Vite build: pass.
- `git diff --check`: pass.
- `npm pack`: pass.
- Lifecycle-enabled packed install: pass.
- Packed CLI help: pass.
- Packed real `init --no-index --no-guidance`: pass.
- Packed real `status`: pass.
- Packed JSON init output parses as JSON and contains no ANSI.
- Packed MCP initialize emits JSON-RPC protocol-only stdout.
- TTY, CI, non-TTY, `NO_COLOR`, JSON bypass, alignment, result states, and
  progress final-frame tests pass.

## Accepted historical failures

The 12 remaining full-suite failures are not Phase14E regressions:

1. `MCP lifecycle, lexical search, graph queries, and Phase 9 tools reuse core services`
2. `facts graph preserves clean-fixture graph nodes and edges`
3. `incremental graph matches a clean full rebuild for imports, calls, extends, malformed, delete, and rename`
4. `extracts one path-neutral fact blob from a TypeScript source snapshot`
5. `records containment ownership for symbols, calls, and references`
6. `extracts export-star facts with their source module`
7. `malformed source publishes reusable deterministic partial facts`
8. `index work counters observe importer invalidation and uncertain resolution fallback`
9. `facts graph does not parse again for member and extends resolution`
10. `facts materialization preserves columns for same-line symbols`
11. `facts member evidence preserves executable template interpolation`
12. `facts evidence handles nested template interpolation and masks nested regex literals`

The first is the accepted Phase10 historical failure. The other eleven are the
accepted Phase14A historical failures.

## Canonical TypeScript/build classification

Classification: C — dependency/environment snapshot issue.

Current HEAD direct typecheck:

```text
src/adapters/http/http-server.ts(227,18): error TS2339: Property 'sendFile' does not exist on type 'FastifyReply<...>'.
```

The accepted pre-Phase14E base `3aab618` produced the exact same diagnostic at
the same location with the same dependency snapshot. Therefore Phase14E did
not cause this failure and no presentation code was changed to work around it.

The canonical `pnpm exec tsc --noEmit` and `pnpm run build` commands are also
blocked before TypeScript execution because the local `node_modules` symlink
points outside the project and pnpm reports `ERR_PNPM_UNSAFE_MODULES_DIR`.

## Package and repository state

- `package.json`: only the requested `picocolors@1.1.1` addition.
- `pnpm-lock.yaml`: matching importer entry only.
- `package-lock.json`: unchanged.
- No Phase15 changes.
- No push or publication performed.

The local `node_modules` symlink is execution-only and is not committed. The
`.worktrees/` directory was left untouched.
