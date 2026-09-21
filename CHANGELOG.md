# Changelog

All notable changes to CodeAtlas are documented here.

## [Unreleased]

## [1.3.0] - 2026-09-21

### Added

- Persistent task-context lifecycles through `context-start`, `context-refresh`, and `context-close`, plus matching MCP tools. A durable `taskContextId` ties together session and context generations; lifecycles can expire and be refreshed or closed.
- Opt-in `code-atlas upgrade [--check] [--json]`. Automatic updates install and verify an exact version for unambiguous global npm or pnpm installs on POSIX; local, linked, Homebrew, wrapper-based, or ambiguous installations require a manual update. Windows checks and updates fail closed with manual guidance. Normal commands do not check for updates.

### Improved

- MCP tool descriptions and input schemas now guide tool selection and field use, with standard read-only, destructive, idempotency, and open-world hints for clients.
- Graph indexing now resolves local Python relative, Kotlin, and Rust module imports into cross-file import edges.

### Fixed

- Context source reads reject repository path traversal and symlink escapes.

### Reliability

- Lifecycle refreshes are scoped to repository/workspace identity and reject stale concurrent revisions. Optional TTLs expire old contexts, and delivery results report full, unchanged, delta, or rehydrated content when applicable.
- Added an internal deterministic, offline task-context evaluation gate using synthetic fixtures and frozen repository snapshots. It checks correctness, reconstruction, determinism, evidence authority and uncertainty, lifecycle isolation, and quality policy; baseline updates are explicit. It uses no LLM judge and adds no public `code-atlas eval` command.
- Added an MCP Inspector contract check against the running stdio server, including initialization, `tools/list`, and tool calls.
