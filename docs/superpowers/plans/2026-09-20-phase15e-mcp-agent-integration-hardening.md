# Phase15E-A — MCP Agent Integration Hardening Plan

> **For agentic workers:** Use `superpowers:subagent-driven-development` one task at a time. Each task has a focused test, a fresh independent review, and an exact-file commit.

**Goal:** Make all current MCP tools easier to select, accurately annotated, and verifiable through the official Inspector.

**Architecture:** Extend the existing `registerJsonTool()` boundary to pass SDK annotations; improve descriptions and only useful Zod field guidance in the existing registration file; verify the real stdio server with the exact-pinned Inspector CLI and a temporary fixture.

**Tech Stack:** TypeScript/ESM, MCP SDK `1.30.0`, Zod `4.5.4`, Node test runner, official `@modelcontextprotocol/inspector` v2 exact version `2.7.0`.

**Spec:** `docs/superpowers/specs/2026-09-20-phase15e-mcp-agent-integration-hardening-design.md`

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

- [ ] Write protocol-level regression tests that create the real MCP server and assert all 28 tools, full classifications for representative read-only/local-write tools, description distinctions, and field-level schema guidance.
- [ ] Run the focused test and record the expected RED result before implementation.
- [ ] Extend the existing registration helper with SDK-supported annotations; define per-tool metadata at registration sites. Add concise descriptions and only material schema descriptions.
- [ ] Repeat the focused test; require tools/list response assertions to pass.
- [ ] Self-review every registered handler against the spec matrix; run independent reviewer and fix P0/P1/P2 findings.
- [ ] Run `git diff --check`; stage only MCP source/test files and commit `feat(mcp): add truthful discoverability metadata`.

### Task 2: Exact-pinned MCP Inspector contract verification

**Files:**
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Create: `test/phase15e-mcp-inspector.test.ts`
- Modify: `test/phase15e-mcp-metadata.test.ts` only if Inspector-exposed expectations need a narrow shared assertion

**Tests:** `node --import tsx/esm --test test/phase15e-mcp-inspector.test.ts` and `pnpm run test:mcp:inspector`.

- [ ] Add the official Inspector v2 package at exact version `2.7.0` and an exact package script `test:mcp:inspector`; update the lockfile through pnpm without unrelated manifest changes.
- [ ] Build a temporary fixture and launch the actual MCP stdio server with Inspector v2 CLI. Assert initialize, tools/list, expected names, descriptions, input schema, annotations, a safe default `repository_status` call (without optional capability initialization), and invalid arguments surfaced as a tool error.
- [ ] Ensure temp fixture cleanup runs on success and failure; do not invoke a mutating tool or read the user's real `.codeatlas` state.
- [ ] Run the focused test and package script; verify the tool process is terminated and output is deterministic enough for assertions.
- [ ] Self-review command argument ordering against current Inspector CLI docs; independent review and fix P0/P1/P2 findings.
- [ ] Stage only package/lock/test files and commit `test(mcp): verify Inspector protocol contract`.

### Task 3: Phase15E-A closure verification

**Files:** no new production files; fix only findings in the owning task.

**Tests:** MCP focused tests, `pnpm run test:mcp:inspector`, `pnpm run eval:context`, `node --import tsx/esm --test test/phase15d-acceptance.test.ts`, `pnpm run build`, `pnpm run lint`, and `git diff --check`.

- [ ] Run all listed gates freshly from the feature worktree and record exact outcomes.
- [ ] Run focused self-review and a fresh independent subsystem reviewer against the spec and task diff; fix P0/P1/P2 findings and re-review changed ranges.
- [ ] Confirm no new Phase15D failure identities were introduced in focused acceptance.
- [ ] Do not merge; proceed to Phase15E-B only after this subsystem's verification and review are clean.

## Completion checklist

- [ ] Every current tool is classified truthfully through protocol `tools/list`.
- [ ] Descriptions and material input descriptions are agent-selectable and current.
- [ ] Inspector exact pin and command are repeatable on the fixture.
- [ ] Reviews contain no unresolved P0/P1/P2 findings.
- [ ] Phase15D evaluator and acceptance still pass.
