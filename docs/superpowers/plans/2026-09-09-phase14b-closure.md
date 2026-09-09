# Phase 14B Closure Record

## Closure status

Implementation complete; accepted pending explicit waiver of inherited baseline failures.

## Revisions

- Base SHA: `531a3c2f89de962af684a154a6a21995f6da5eaa`
- Final implementation/audit HEAD: `4402510a6f3852ded7431d1996690e898f9caba2`
- Equivalent isolated pre-closure baseline used for reproduction: `ae33542`
- Worktree was clean before this closure document was created.

## Test outcomes

The focused Phase 14B run completed with:

- 139 total
- 137 pass
- 1 fail
- 1 skip

The full CI run completed with:

- 450 total
- 438 pass
- 11 fail
- 1 skip

The focused failure and all full-suite failures are inherited. The equivalent
isolated baseline `ae33542` and final HEAD produced the same targeted result:
46 total, 35 pass, 11 fail, and 0 skip, with the following identical failures:

| # | Test | Baseline | Final HEAD |
|---:|---|---|---|
| 1 | `MCP lifecycle, lexical search, graph queries, and Phase 9 tools reuse core services` | fail | fail |
| 2 | `facts graph preserves clean-fixture graph nodes and edges` | fail | fail |
| 3 | `extracts one path-neutral fact blob from a TypeScript source snapshot` | fail | fail |
| 4 | `records containment ownership for symbols, calls, and references` | fail | fail |
| 5 | `extracts export-star facts with their source module` | fail | fail |
| 6 | `index work counters observe importer invalidation and uncertain resolution fallback` | fail | fail |
| 7 | `facts graph does not parse again for member and extends resolution` | fail | fail |
| 8 | `facts materialization preserves columns for same-line symbols` | fail | fail |
| 9 | `facts member evidence preserves executable template interpolation` | fail | fail |
| 10 | `facts evidence handles nested template interpolation and masks nested regex literals` | fail | fail |
| 11 | `fact extraction returns every objective array and complete parser identity` | fail | fail |

Therefore, no new Phase 14B regressions were introduced by the final audit
fixes.

## Packaging and environment

- `npm pack`: pass when run with a temporary npm cache.
- Packed CLI `--help`: pass.
- Packed MCP initialize/smoke: 2/2 pass.
- The default npm cache was blocked by an existing root-owned cache entry
  (`EPERM`).
- Clean package installation was also blocked by host network/DNS failures
  while downloading `tree-sitter-cli` from GitHub and accessing the npm
  registry (`ENOTFOUND github.com`, `ENOTFOUND registry.npmjs.org`).
- The normal test glob skipped the packed CLI test when `PACKED_CLI_PATH` was
  unset; the required packed MCP check was run separately and passed.

These are environment/install blockers. The packed artifact, CLI, and MCP
process smoke passed, so no package regression was demonstrated.

## Review and scope

- Broad review covered the Phase 14B change range and the final audit-fix diff.
- Final review result: no remaining P0, P1, or P2 findings.
- The audit fixes cover `implements`/`references` graph persistence,
  incremental provenance and invalidation, graph/intelligence/query consumers,
  and repository-status edge breakdown.
- `package.json`, `pnpm-lock.yaml`, and `package-lock.json` were unchanged.

## Verification gates

- Build: pass
- Lint: pass
- TypeScript check: pass
- UI typecheck: pass
- `git diff --check`: pass

No merge, push, publish, branch deletion, or worktree removal was performed.
