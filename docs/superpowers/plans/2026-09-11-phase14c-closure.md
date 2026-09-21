# Phase 14C Closure Record

Date: 2026-09-11
Branch: `codex/phase14c-framework-dynamic-edges`
Implementation HEAD: `edc62ffee8cd90cfa1454a8190ddb30e2e61e388`
Merge-base with `fix/cli-index-progress-ux`: `a5bf0f8a00381cf02297e58c571f3456d1f75720`

## Review waiver

Independent reviewer capacity is intentionally waived for Phase 14C because
subagents are disabled by instruction. The review below is controller-only. No
independent review was performed or claimed.

## Controller-only broad review

Reviewed the committed range `merge-base..HEAD` together with the current
uncommitted remediation diff. The review covered framework contracts, adapter
separation, objective-facts inputs, entity identity, relationship/classification
decoding, provenance/conflict handling, incremental ownership/reuse,
framework-resolution versioning, persistence/publication, query projection,
coverage/completeness, read-only behavior, and packed runtime behavior.

No new Phase14C P0/P1/P2 finding was identified by the controller-only review.

## Verification

| Gate | Result |
| --- | --- |
| Phase14C | 145 total, 144 pass, 0 fail, 1 skip |
| Phase14B | 139 total, 138 pass, 0 fail, 1 skip |
| Phase13 | 12/12 pass |
| CLI UX | 9/9 pass |
| Phase14A | 69 total, 58 pass, 11 fail, 0 skip |
| Full CI suite | 604 total, 570 pass, 32 fail, 2 skip |
| TypeScript | pass |
| ESLint | pass when run directly; pnpm wrapper attempted an unwanted reinstall |
| UI typecheck | pass using local toolchain |
| Vite build | pass using local toolchain |
| `git diff --check` | pass |
| Native Kotlin/Dart imports | pass |
| `npm pack` | pass |
| Lifecycle-enabled packed install | pass |
| Packed CLI help | pass |
| Packed representative help | pass |
| Packed unknown command and `unknown --help` | both exit non-zero |
| Packed MCP initialize/rejection smoke | 4/4 pass |

## Remaining failures and blockers

The accepted Phase14A waiver expanded from 9 to 11 only after baseline evidence
was recorded. The two additional inherited failures are exactly:

- `incremental graph matches a clean full rebuild for imports, calls, extends, malformed, delete, and rename`
- `malformed source publishes reusable deterministic partial facts`

The two additional names were reproduced individually at the pre-Phase14C
baseline `a5bf0f8a00381cf02297e58c571f3456d1f75720` and at current HEAD. Both
produced the same assertion outcome (`failed`, while the test expects
`published`). They are therefore classified as inherited historical failures
omitted from the old waiver, not Phase14C regressions and not order-dependent
failures. The accepted waiver now covers 11 failures.

The remaining nine Phase14A failures are the previously accepted historical
failure names. No Phase14C regression was found.

The three Phase12 CLI failures are environment/setup failures caused by the
tests refusing the ephemeral `dist/cli.js` launcher for durable integration
configuration:

- `connect configures Codex and default CodeAtlas guidance`
- `modern and legacy integration aliases produce equivalent config changes`
- `Codex MCP configuration launches with a minimal PATH and clean JSON-RPC stdout`

The full-suite remainder contains exactly 20 integration/durable-launcher
environment failures and one Zoo environment failure:
`Zoo maps disabled, stale, malformed, and legacy entries safely`. No Phase14C
test failed.

The pnpm script wrapper attempted a reinstall and was blocked by registry DNS
(`ENOTFOUND`) after local dependencies were replaced. Verification continued
with a local dependency tree and a temporary npm cache; repository manifests and
lockfiles were not changed.

## Repository state

Package and lockfiles are unchanged after `edc62ff`. The source and test
remediation changes are committed. No commit, merge, push, publish, branch
deletion, or worktree deletion was performed by the closure record update.

## Closure status

Controller-only review and final verification are recorded. Phase14C itself has
no regression; merge readiness still depends on the repository's explicit
acceptance of the 11-test historical waiver and any remaining environment
failures.
