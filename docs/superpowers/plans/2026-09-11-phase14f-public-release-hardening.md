# Phase 14F Public Release Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task with verification checkpoints.

**Goal:** Make tagged CodeAtlas releases reproducibly verify, publish to npm with Trusted Publishing, and create matching GitHub Releases without duplicate or fail-open behavior.

**Architecture:** `publish.yml` owns tag validation, lifecycle-enabled dependency hydration, release verification, package-content checks, packed consumer smoke, npm idempotency, and provenance-enabled publication. `release.yml` independently confirms the exact npm version before a separate `contents: write` job creates or validates the GitHub Release. Static contract tests protect the workflows without creating real tags, registry publishes, or releases.

**Tech Stack:** GitHub Actions, Node 24, npm 11.5.1+, pnpm 11.22.0, npm Trusted Publishing/provenance, node:test, Ruby YAML parser for local syntax validation.

**Spec:** Phase14F public release-hardening requirements supplied in the approved task request.

## Global Constraints

- Release workflows run only for exact `vX.Y.Z` tags.
- No version bumping, automatic tagging, commit pushing, or main-branch-only publication.
- npm publication uses OIDC Trusted Publishing and `--provenance`; no `NPM_TOKEN` path.
- Native Kotlin/Dart lifecycle builds remain enabled.
- npm and GitHub release failures fail closed.
- JSON/MCP protocol output must remain machine-readable and presentation changes must not enter MCP stdout.
- No Phase15 behavior.

### Task 1: Workflow contracts and package metadata

**Files:**

- Create: `.github/workflows/publish.yml`
- Create: `.github/workflows/release.yml`
- Create: `LICENSE`
- Test: `test/phase14f-release-workflows.test.ts`

- [ ] Validate exact tags, package version/name/bin, Node/npm floors, permissions, lifecycle install, package contents, packed CLI/MCP smoke, npm duplicate handling, and GitHub duplicate handling in static tests.
- [ ] Run `node --import tsx/esm --test test/phase14f-release-workflows.test.ts`.
- [ ] Run `git diff --check` and inspect workflow/package diffs.
- [ ] Commit the workflow hardening changes without creating tags or releases.

### Task 2: Release-hardening audit

**Files:**

- Review: `.github/workflows/publish.yml`
- Review: `.github/workflows/release.yml`
- Review: `test/phase14f-release-workflows.test.ts`

- [ ] Confirm registry errors other than exact verified package-not-found fail closed.
- [ ] Confirm release creation is downstream of npm verification and only the release job has `contents: write`.
- [ ] Confirm package smoke uses lifecycle scripts and an isolated consumer.
- [ ] Run focused static tests, YAML parsing, `git diff --check`, and package/lockfile checks.
- [ ] Do not create a real tag, publish, or GitHub Release.
