# Phase15E-B — CLI Self-Upgrade Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` one task at a time. Each task has a focused test, a fresh independent review, and an exact-file commit.

**Goal:** Add explicit, verifiable CLI self-upgrade and check workflows for supported global npm/pnpm installations.

**Architecture:** Add a lazy CLI command and help entry, implement a small injectable workflow using Node built-ins and shell-free package-manager calls, and test through fake adapters/temp roots.

**Tech Stack:** TypeScript/ESM, Node.js 22+, Node `execFile`, filesystem realpath, built-in test runner, existing CLI JSON/error conventions.

**Spec:** `docs/superpowers/specs/2026-09-20-phase15e-cli-self-upgrade-design.md`

## Global Constraints

- Stay on `feat/phase15e-dx-integration-hardening`; preserve primary `AGENTS.md` and `.worktrees/` exactly.
- Do not add auto-update to ordinary commands.
- Automatic install is only for an unambiguous global npm/pnpm package on POSIX. Unsupported sources/platforms never mutate.
- On Windows, `upgrade --check` must not invoke npm/pnpm `.cmd` shims through `execFile`; return manual registry-check instructions with no process calls.
- Unknown or ambiguous install sources must not display a guessed global install command; direct users to their original installation method.
- Do not invoke a package-manager command with `shell: true`; do not invoke `latest` for installation.
- Never touch a developer's actual global install in tests; no local project dependency update, sudo, force, or cleanup.
- Preserve CLI progress/theme behavior and existing global `--json` error behavior.
- Stage exact files.

## Current repository seams

- CLI dispatch/version: `src/cli.ts`.
- Command help and known-command validation: `src/adapters/cli/cli-help.ts`.
- Package identity/version and script conventions: root `package.json`.
- Tests use Node's built-in runner and fake/temp process state.

## Review Focus

- Manager detection compares resolved package roots and refuses ambiguous or unsupported installs.
- Registry query honors manager configuration and failures do not proceed to install.
- Version comparison handles SemVer precedence, including prerelease ordering.
- Install args contain package name and an exact validated version; all processes are shell-free. Windows performs no registry process invocation, and unknown sources receive no guessed install command.
- Verification launches the installed entrypoint and compares its reported version.
- Tests cannot modify the real global install; Windows limitation and manual guidance are explicit.

### Task 1: CLI surface and read-only upgrade check

**Files:**
- Modify: `src/cli.ts`
- Modify: `src/adapters/cli/cli-help.ts`
- Create: `src/adapters/cli/upgrade.command.ts` (or the smallest existing command location that keeps dispatch lazy)
- Create: `test/phase15e-upgrade-check.test.ts`

**Tests:** `node --import tsx/esm --test test/phase15e-upgrade-check.test.ts`.

- [ ] Add tests for `upgrade --check` output, JSON success shape, already-latest/update-available, SemVer precedence (including prereleases), registry failure, current version, and no install invocation.
- [ ] Run tests to record RED.
- [ ] Implement explicit lazy command, help/known-command registration, manager registry selection, exact SemVer comparison, and `--check` output using injected dependencies.
- [ ] Test npm/pnpm source detection via temporary roots/fakes; unsupported sources receive original-install-method guidance without a guessed command, while Windows provides manual registry-check instructions without process invocation.
- [ ] Run focused tests, self-review, fresh independent review, and fix P0/P1/P2 findings.
- [ ] Commit only CLI/help/module/test files as `feat(cli): add upgrade check`.

### Task 2: Exact global upgrade and installed-version verification

**Files:**
- Modify: `src/adapters/cli/upgrade.command.ts`
- Create or modify: `test/phase15e-upgrade-install.test.ts`

**Tests:** `node --import tsx/esm --test test/phase15e-upgrade-check.test.ts test/phase15e-upgrade-install.test.ts`.

- [ ] Test exact install command for npm and pnpm, shell-free runner arguments, manager/install failures, post-install version mismatch, and successful verification.
- [ ] Confirm RED before implementation.
- [ ] Implement manager-specific global exact-version install and invoke the resolved global entrypoint with `process.execPath` to verify the target version; unsupported/ambiguous paths return before mutation.
- [ ] Assert tests only use fakes and temporary roots and never call real global package-manager commands.
- [ ] Run focused tests, self-review, fresh independent review, and fix P0/P1/P2 findings.
- [ ] Commit only upgrade module and tests as `feat(cli): add verified self-upgrade`.

### Task 3: Phase15E-B closure verification

**Files:** no new production files; fix only findings in the owning task.

**Tests:** focused upgrade tests, Phase15D evaluator, Phase15D acceptance, build, lint, and `git diff --check`.

- [ ] Run every listed gate freshly from the feature worktree and record exact outcomes.
- [ ] Run focused self-review and a fresh independent subsystem review against the spec, tests, and task diff; fix P0/P1/P2 findings and re-review.
- [ ] Confirm no ordinary CLI command performs package lookup or mutation.
- [ ] Do not merge; proceed to the shared docs gate only after this subsystem's verification and review are clean.

### Task 4: Shared README/docs release gate

**Files:**
- Modify: `README.md`

**Tests:** focused documentation assertions if existing conventions support them; otherwise `git diff --check` plus exact manual content review.

- [ ] Document current MCP discoverability/annotations, Inspector contributor command, upgrade/check commands, supported source/package-manager/platform matrix, limitations, and developer verification flow.
- [ ] Preserve the product thesis, `graph ready != graph complete`, and `mayBeIncomplete=true` warning.
- [ ] Remove no existing useful documentation and add no future Phase16/17/18 capability claims.
- [ ] Independent broad documentation review; fix stale/overstated claims.
- [ ] Commit only `README.md` as `docs: document Phase15E integration hardening`.

## Completion checklist

- [ ] Check and upgrade are explicit, safe, shell-free, and verifiable.
- [ ] npm/pnpm global source matrix and unsupported paths are accurately surfaced.
- [ ] No test uses or mutates the real global installation.
- [ ] README describes only implemented behavior.
- [ ] Reviews contain no unresolved P0/P1/P2 findings.
