# Phase15E-A — MCP Agent Integration Hardening Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` one task at a time. Each task has a focused test, a fresh independent review, and an exact-file commit.

**Goal:** Make all current MCP tools easier to select, accurately annotated, and verifiable through the official Inspector.

**Architecture:** Extend the existing `registerJsonTool()` boundary to pass SDK annotations; improve descriptions and only useful Zod field guidance in the existing registration file; verify the real stdio server with the exact-pinned Inspector CLI and a temporary fixture.

**Tech Stack:** TypeScript/ESM, MCP SDK `1.30.0`, Zod `4.5.4`, Node test runner, official `@modelcontextprotocol/inspector` v2 exact version `2.7.0`.

**Spec:** `docs/superpowers/specs/2026-09-20-phase15e-mcp-agent-integration-hardening-design.md`

**Status:** MCP implementation and Phase15E-A gates are complete. The final shared feature-worktree suite had 855 total, 819 passed, 34 failed, and 2 skipped: 12 canonical failure identities match the accepted base list, and the other 22 are known `/private/tmp` durable-launcher/integration identities. Canonical post-merge verification passed with 855 total, 841 passed, the same 12 accepted baseline failures, and 2 skipped.

## Global Constraints

- Stay on `feat/phase15e-dx-integration-hardening`; preserve the primary dirty paths `AGENTS.md` and `.worktrees/`.
- Do not change MCP analysis, persistence, or Git semantics to simplify the tests.
- Do not mark all tools read-only; `repository_status` is conditionally mutating.
- Current provider wiring is local-only; do not claim future semantic/network behavior.
- Do not change source files or Git state from Inspector verification.
- Never use an unpinned Inspector release or claim it proves agent routing.
- Stage exact files; do not stage `docs/plan.md`, `docs/git-workflow.md`, or user state.

## Current repository seams

- Tool registration and `tools/list` schema: `src/adapters/mcp/mcp-server.ts`.
- Existing tests/protocol setup: `test/phase10-mcp.test.ts`, `test/phase15d-acceptance.test.ts`.
- Package scripts/dependencies: root `package.json`, `pnpm-lock.yaml`.
- Package runs MCP through `code-atlas mcp`; Inspector can launch that actual stdio command against an isolated fixture.

## Review Focus

- Compare every annotation to actual handler side effects, especially optional `repository_status` initialization, lexical metadata writes, context receipts/lifecycle state, and index-generation replacement.
- Ensure all 28 tools remain registered and descriptions distinguish nearest neighbors.
- Ensure real Inspector output includes annotations and schema, the invalid call is an MCP tool error, and no real `.codeatlas` state is touched.
- Keep the Inspector dependency exact and lockfile-backed.

### Task 1: Truthful annotations, discoverable descriptions, and schema guidance

**Files:**
- Modify: `src/adapters/mcp/mcp-server.ts`
- Modify: `test/phase10-mcp.test.ts` or a focused `test/phase15e-mcp-metadata.test.ts`

**Tests:** `node --import tsx/esm --test test/phase15e-mcp-metadata.test.ts` (or the focused MCP test file chosen to match existing organization).

- [x] Write protocol-level regression tests that create the real MCP server and assert all 28 tools, full classifications for representative read-only/local-write tools, description distinctions, and field-level schema guidance.
- [x] Run the focused test and record the expected RED result before implementation.
- [x] Extend the existing registration helper with SDK-supported annotations; define per-tool metadata at registration sites. Add concise descriptions and only material schema descriptions.
- [x] Repeat the focused test; require tools/list response assertions to pass.
- [x] Self-review every registered handler against the spec matrix; run independent reviewer and fix P0/P1/P2 findings.
- [x] Run `git diff --check`; stage only MCP source/test files and commit `feat(mcp): add truthful discoverability metadata`.

### Task 2: Exact-pinned MCP Inspector contract verification

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `test/phase15e-mcp-inspector.test.ts`
- Modify: `test/phase15e-mcp-metadata.test.ts` only if Inspector-exposed expectations need a narrow shared assertion

**Tests:** `node --import tsx/esm --test test/phase15e-mcp-inspector.test.ts` and `pnpm run test:mcp:inspector`.

- [x] Add the official Inspector v2 package at exact version `2.7.0` and an exact package script `test:mcp:inspector`; update the lockfile through pnpm without unrelated manifest changes.
- [x] Build a temporary fixture and launch the actual MCP stdio server with Inspector v2 CLI. Assert initialize, tools/list, expected names, descriptions, input schema, annotations, a safe default `repository_status` call (without optional capability initialization), and invalid arguments surfaced as a tool error.
- [x] Ensure temp fixture cleanup runs on success and failure; do not invoke a mutating tool or read the user's real `.codeatlas` state.
- [x] Run the focused test and package script; verify the tool process is terminated and output is deterministic enough for assertions.
- [x] Self-review command argument ordering against current Inspector CLI docs; independent review and fix P0/P1/P2 findings.
- [x] Stage only package/lock/test files and commit `test(mcp): verify Inspector protocol contract`.

### Task 3: Phase15E-A closure verification

**Files:** no new production files; fix only findings in the owning task.

**Tests:** MCP metadata and CLI focused tests, `pnpm run test:mcp:inspector`, `pnpm run eval:context`, `node --import tsx/esm --test test/phase15d-acceptance.test.ts`, `pnpm run build`, CLI/UI typechecks, `pnpm run lint`, and commit-range `git diff --check`.

**Recorded results:** MCP metadata plus CLI focused tests 16/16; Inspector 1/1; Phase15D acceptance 6/6; `pnpm run eval:context` exit 0; `pnpm run build` exit 0; CLI `tsc --noEmit` exit 0; UI typecheck exit 0; lint exit 0; commit-range diff check exit 0. Full suite: 855 total, 819 passed, 34 failed, 2 skipped; its 12 canonical failure identities exactly match the accepted base list and the other 22 are known `/private/tmp` durable-launcher/integration identities. This is not a full-suite pass. Full-suite TAP: `.superpowers/sdd/2026-09-20-phase15e-cli-self-upgrade/final-full-suite.tap`, copied byte-for-byte from `/private/tmp/phase15e-full-suite-final.tap` without rerunning.

**Recorded primary post-merge results:** canonical `node --import tsx/esm --test test/*.test.ts` completed with 855 total, 841 passed, 12 failed, and 2 skipped; all 12 failures are the accepted baseline identities. MCP metadata plus CLI focused tests 16/16; Inspector 1/1; Phase15D acceptance 6/6; context evaluator exit 0; build, CLI/UI typechecks, lint, and commit-range diff check passed. TAP: `/private/tmp/phase15e-postmerge-canonical-with-inspector.tap`. The primary checkout's `pnpm run` dependency check requested a noninteractive modules-directory purge, so verification used equivalent direct Node/test and local-binary commands without installing or purging dependencies.

- [x] Run all listed gates freshly from the feature worktree and record exact outcomes above.
- [x] Run focused self-review and a fresh independent subsystem reviewer against the spec and task diff; fix P0/P1/P2 findings and re-review changed ranges.
- [x] Confirm no new Phase15D failure identities were introduced in focused acceptance.
- [x] Keep this task unmerged and proceed to Phase15E-B only after this subsystem's verification and review are clean.

## Completion checklist

- [x] Every current tool is classified truthfully through protocol `tools/list`.
- [x] Descriptions and material input descriptions are agent-selectable and current.
- [x] Inspector exact pin and command are repeatable on the fixture.
- [x] Final independent review confirms the cross-document completion/status edits contain no unresolved P0/P1/P2 findings.
- [x] Phase15D evaluator and acceptance still pass.
- [x] Canonical full suite was rerun after local merge; only the 12 accepted baseline failure identities remain.
