# Changelog

All notable changes to CodeAtlas are documented here.

## [Unreleased]

## [1.6.1] - 2026-10-10

### Security and correctness

- Bind the HTTP inspector to loopback by default; require explicit external binding and validate Host/Origin. Source access is restricted to indexed, non-secret, non-ignored files and rejects symlink traversal/replacement.
- Keep lexical ranking for long owner-context queries without exceeding SQLite parameter limits, including repeated and Unicode terms.
- Enforce generation-parent checks within the publication transaction and respect ignored directories and nested repositories when scanning config.
- Prevent unpublished semantic candidate vectors from leaking through legacy readers during first indexing or migration. Historical generation retention and duplicate vector storage are deferred to v1.6.2.

### Distribution

- Restore and verify pinned Tree-sitter bindings and four-platform native payloads in fresh qualification and publication checkouts, preserving all twelve supported languages.
- Handle npm prepack output and Windows artifact paths, and retain portable CLI/MCP and macOS x64 ONNX embedding checks.

## [1.6.0] - 2026-10-08

### React lazy routes and MCP guidance

- Recognize parser-proven named `export const` bindings and resolve explicitly verified `lazyRouteNamed(() => import("literal"), "NamedExport")` routes through local helpers, TypeScript aliases and re-exports. Keep computed/unverified targets fail-closed and pre-existing dynamic JSX partial rather than inventing relationships.
- Clarify MCP tool discovery: `inspect_change` accepts Git working/staged/commit/range sources; use `compile_task_context` with file anchors for named file lists.
- Facts version `3.1.2` and framework resolution version `1.7.1` invalidate affected older evidence safely. The first post-upgrade sync reparses old fact-cache entries and rematerializes framework relationships; performance may temporarily differ from a no-op sync.

### Improved

- Incremental indexing now reuses a published generation on true no-op `index` and `sync`, without parsing, resolution, or storage writes when source and capability inputs have not changed.
- Bounded source edits reuse unchanged graph, lexical, framework, and semantic evidence; unchanged symbols retain embeddings rather than being re-embedded.
- More precise handling of framework lookups and downstream re-export invalidation, while preserving conservative incomplete-evidence behavior.

### Reliability

- Cross-process index writer locking rejects overlapping operations and recovers from terminated writers.
- Semantic provider identities distinguish otherwise-colliding configurations; legacy stored identities receive a safe semantic refresh.
- Python build/exclude behavior is consistent between scanning and incremental sync.

### Verification and compatibility

- Added Windows CI coverage for native parsers, CLI indexing and delta sync, MCP Inspector, packed npm consumers, and real MiniLM/ONNX embedding on `develop`.
- Verified Windows 11 incremental indexing and semantic reuse on a real TypeScript/React workspace: 512 parsed-source files and 3,147 semantic vectors; a no-change semantic-enabled sync reused the generation without embedding or DB transactions.
- Existing indexes may perform a one-time semantic rebuild after provider identity migration. CPU-only MiniLM embedding can be slow on large workspaces; subsequent no-op syncs reuse existing vectors.
- The known 12 pre-existing full-suite canonical failures remain outside the targeted release verification gate; no claim of a green full suite is made.

## [1.5.0] - 2026-10-07

### Added

- Execution-flow discovery, repository architecture maps, and a framework entry catalog covering HTTP/web routes, declared GraphQL resolvers, scheduled jobs, and messaging consumers.
- Static messaging producer/consumer links within repositories and across explicitly selected workspace members.
- Workspace membership, pinned-generation health, and exact declared JS/TS npm package dependency candidates through read-only MCP queries; `code-atlas workspace map` adds a CLI membership view.

### Improved

- Precision-first JVM and ECMAScript member-call resolution, framework partial-evidence reporting, and snapshot-consistent query projections.
- Strict framework package-config acquisition now rejects duplicate keys and preserves exact byte/hash integrity.

### Compatibility

- Existing CLI commands and MCP inputs remain available. Resolution, facts, and framework evidence versions changed since 1.4.0; refresh existing indexes with `code-atlas sync` (or rebuild with `code-atlas index`) before relying on current evidence.
- Workspace links are static candidates only: they do not prove runtime delivery, package installation, or semver satisfaction. npm aliases, local/workspace protocols, nested package federation, and Phase17D-C2 remain deferred.

## [1.4.0] - 2026-09-29

### Added

- Optional semantic embeddings with a built-in local provider and an OpenAI-compatible provider. The semantic lifecycle supports setup, status, test, upgrade, disable, and clean operations.
- Hybrid lexical and semantic retrieval, plus retrieval inspection for vector, lexical, fused, reranked, and context stages.

### Improved

- SCIP adds TypeScript/JavaScript cross-file binding evidence when a local `scip-typescript` executable is available; parser-based indexing remains the baseline and fallback.
- Lexical relevance ordering now uses qualified owner context where known, while bare-identifier and hybrid ranking preserve ambiguity-safe tie behavior.
- Compact retrieval inspection preserves each retrieval stage independently, including candidates that appear in multiple stages.

### Reliability

- Semantic setup, indexing, and search remain optional and local-first; semantic failures fall back to lexical and graph retrieval without blocking graph or lexical publication.

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
