# Phase 14B Multi-Language Resolver & TypeEnvironment v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the complete Phase 14B objective-facts-to-bounded-semantic-resolution pipeline for JavaScript, TypeScript, TSX, Python, Java, Kotlin, Go, Rust, Swift, Dart, C, and C++.

**Architecture:** Keep parsing and objective extraction in the existing language registry/fact-cache boundary. Normalize facts through language-owned semantic adapters into a generation-scoped `TypeEnvironment`; run one language-agnostic, deterministic resolver that emits explicit decisions and only accepted edges. Extend the existing candidate-generation transaction so `parsePaths`, `reusePaths`, and `resolvePaths` produce a complete candidate graph without copying active-generation row identities.

**Tech Stack:** TypeScript 7.0.2, Node.js >=22, pnpm 11.22.0, `tree-sitter` 0.25.1 native Node bindings, SQLite through `node:sqlite`, `node:test`, existing listr2 CLI/MCP/UI stack.

**Spec:** [2026-09-07-phase14b-multilanguage-resolver-typeenvironment-v2-design-revised.md](<HOME>/code-atlas/docs/superpowers/specs/2026-09-07-phase14b-multilanguage-resolver-typeenvironment-v2-design-revised.md)

## Global Constraints

- `ParsedFacts = what the source objectively contains`; facts contain no chosen targets, confidence, strategy conclusions, or speculative cross-file targets.
- Semantic adapters and resolver strategies consume `ParsedFacts`/`SemanticEvidence`; they do not call Tree-sitter, another parser, source-text regexes, or ad-hoc source scanners.
- Resolution decisions are exactly `resolved`, `ambiguous`, `unknown`, `unsupported`, or `budget_exhausted`.
- Confidence is exactly `exact`, `strong`, or `weak`; weak-only evidence never creates an authoritative edge.
- `exact` or `strong` with one target is accepted; multiple plausible targets are `ambiguous`; no candidate is `unknown`; unsupported constructs are `unsupported`; deterministic work-limit hits are `budget_exhausted`.
- `schemaVersion` is Atlas storage layout; `factsSchemaVersion` is persisted fact payload/codec shape; `factsVersion` is objective extraction semantics; `parserIdentity` is parser runtime plus grammar provenance; `resolutionVersion` is adapter/resolver/accepted-edge meaning; `derivedVersion` is derived projection semantics.
- Semantic adapter changes belong to `resolutionVersion`, not `parserIdentity`.
- A resolution-version bump reuses compatible facts, parses zero files, rebuilds `TypeEnvironment`, resolves repository-wide, and carries no old-resolution-version semantic edge into the candidate.
- A candidate generation contains a complete graph. Unaffected semantic state is logically rebound/carry-forwarded only when proven safe; otherwise resolution expands to the repository.
- Never copy active-generation raw database row IDs into candidate semantic identities.
- No semantic invalidation optimization, framework semantics, compiler/LSP requirement, embeddings, LLM resolution, watcher, context intelligence, repository memory, persistent `TypeEnvironment`, or Phase14D dashboard/presentation work.
- All eleven target languages must pass their applicable support floor before Phase14B is complete as an eleven-language feature.
- Existing Phase13/read-only, Phase14A cache/generation, CLI, MCP, optional semantic-provider, WAL, and freshness contracts remain intact.
- `package.json` and `pnpm-lock.yaml` may change only in the language-enablement dependency task; no other task owns them.

## Current repository anchors

- Parser registry: `src/core/graph/parsers/types.ts`, `languages.ts`, `registry.ts`, `code-parser.ts`; currently only TypeScript, TSX, and JavaScript.
- Facts: `src/core/facts/facts.types.ts`, `facts-extractor.ts`, `facts-codec.ts`, `facts-identity.ts`; current model lacks assignments, parameters, returns, receiver/member chains, and language-specific ownership facts.
- Pipeline: `src/core/indexing/index-pipeline.service.ts`; it calculates `resolvePaths` but currently resolves all units when rebuilding.
- Invalidation: `src/core/indexing/invalidation-planner.ts`; it already exposes `parsePaths`, `reusePaths`, `resolvePaths`, and conservative full-resolution fallback.
- Graph seams: `build-graph.ts`, `build-file-updates.ts`, `call-resolution.ts`, `member-resolution.ts`, `extends.ts`.
- Storage: `src/storage/atlas/atlas.schema.ts` and `atlas.store.ts`; generation rows are atomic but edge provenance is legacy numeric confidence/location.
- Existing commands: `pnpm test`, `pnpm run lint`, `pnpm exec tsc --noEmit`, `pnpm run ui:typecheck`, `pnpm run build`.

## Dependency DAG

```text
14B-0 version/invalidation/candidate-scope prerequisites
        ↓
14B-1 ParsedFacts v2 contract and cache compatibility
        ↓
14B-2 evidence, TypeEnvironment, decisions, strategies, determinism
        ↓
14B-3 language enablement ───────────────┐
        ↓                                │
14B-4 provenance/storage/diagnostics ←───┘
        ↓
14B-5 generation/incremental/conformance/regression closure
```

Track 14B-3 family implementations can execute in parallel after 14B-1, but the parser/scanner/package integration task is single-owner and runs before registry conformance. Track 14B-4 can begin its type/schema work after 14B-2 contracts exist, but persistence integration waits until the language adapters and resolver outputs are stable. Track 14B-5 is sequential after all previous tracks.

## Track ownership and conflict boundaries

| Track | Owns | Does not own |
|---|---|---|
| 14B-0 | version domains, invalidation scope, candidate resolution scope, importer provenance | facts payload shape, resolver algorithms, package manifest |
| 14B-1 | facts types, extraction contract, codec/identity, fact fixtures | resolver target selection, storage edge columns |
| 14B-2 | resolver contracts, evidence normalization, environment, decisions, strategies, resolver-side graph integration | language grammar modules, SQLite migrations |
| 14B-3 integration owner | scanner, registry, grammar dependencies, parser identities, family adapter modules and fixtures | storage, candidate publication |
| 14B-4 | graph edge provenance, schema migrations, legacy mapping, diagnostics/coverage primitives | language extraction and resolver strategy semantics |
| 14B-5 | pipeline assembly, end-to-end fixtures, equivalence, regression and packaging closure | new language semantics or new storage fields |

High-conflict files have one owner: `package.json`/`pnpm-lock.yaml` → 14B-3 integration; `registry.ts`/`languages.ts` → 14B-3 integration; `facts.types.ts`/`facts-codec.ts` → 14B-1; `build-graph.ts`/`build-file-updates.ts` → 14B-2 then 14B-5 integration; `atlas.schema.ts`/`atlas.store.ts` → 14B-4; `index-pipeline.service.ts` → 14B-0 scope helper followed by 14B-5 orchestration integration.

## Execution tracks

1. [14B-0 — Index and resolution prerequisites](2026-09-08-phase14b-0-index-resolution-prerequisites.md)
2. [14B-1 — ParsedFacts semantic sufficiency](2026-09-08-phase14b-1-parsed-facts-semantic-sufficiency.md)
3. [14B-2 — Semantic resolver core](2026-09-08-phase14b-2-semantic-resolver-core.md)
4. [14B-3 — Language enablement](2026-09-08-phase14b-3-language-enablement.md)
5. [14B-4 — Provenance, diagnostics, and migration](2026-09-08-phase14b-4-provenance-diagnostics-migration.md)
6. [14B-5 — Conformance and regression closure](2026-09-08-phase14b-5-conformance-regression.md)

## Checkpoints

- **After 14B-0:** version-domain tests prove independent invalidation; planner tests prove safe bounded scope and mandatory repository fallback; no candidate scope can omit a graph unit.
- **After 14B-1:** every required objective fact has a codec round trip, path-neutral identity, coordinated facts schema/version behavior, and no resolver source-text fallback is needed for the declared fact contract.
- **After 14B-2:** resolver-core fixtures prove exact/strong/weak, all five terminal outcomes, deterministic budgets, memo equivalence, canonical ordering, and generation isolation without language-specific target selection.
- **After 14B-3:** every target language is scanner-registered, parser-packaged, fact-extracted, adapter-normalized, capability-profiled, and has floor/ambiguity/unknown/budget/determinism fixtures. A language is not advertised before its floor passes.
- **After 14B-4:** accepted edges persist strategy, categorical confidence, bounded provenance, and `resolutionVersion`; legacy rows remain readable without fabricated Phase14B evidence; read-only opens perform no migration.
- **After 14B-5:** incremental normalized graph equals clean rebuild, resolution-only changes parse zero files, candidate failure preserves active state, all required regressions and packaging/MCP gates pass.

## Spec-to-plan coverage map

| Design sections | Plan coverage |
|---|---|
| §§1–4 | Global constraints, Track 14B-1, Track 14B-2, Track 14B-3 |
| §§5–7 | Track 14B-1 Tasks 1.1–1.2; Track 14B-2 Task 2.1; Track 14B-3 Tasks 3.1–3.7 |
| §§8–14 | Track 14B-2 Tasks 2.1–2.4 |
| §§15–17 | Track 14B-4 Tasks 4.1–4.3 |
| §18 | Track 14B-3 Tasks 3.2–3.7 and language fixture checkpoint |
| §§19–21 | Track 14B-0 Task 0.1; Track 14B-1 Tasks 1.1–1.3; Track 14B-3 capability task |
| §§22–30 | Track 14B-0 Tasks 0.2–0.4; Track 14B-2 Task 2.4; Track 14B-5 Tasks 5.1–5.3 |
| §§31–36 | Track 14B-4 Tasks 4.1 and 4.3; global scope constraints |
| §§37–39 | Track 14B-3 language fixtures; Track 14B-5 Task 5.4 |
| §§40–41 | Track 14B-5 Tasks 5.2–5.4 |
| §§42–46 | Track 14B-3 Task 3.8; Track 14B-5 Task 5.4 |
| §47 | Track 14B-0 Task 0.1; Track 14B-1 Task 1.3; Track 14B-4 Tasks 4.2–4.3; Track 14B-5 Task 5.3 |
| §§48–51 | Track 14B-4 diagnostics; Track 14B-5 regression and public compatibility gates |
| §§52–55 | Global constraints, scope checkpoint, and final closure gate |

## Final Phase14B closure gate

Run from a clean dependency-install state:

```bash
pnpm run build
pnpm test
pnpm run lint
pnpm exec tsc --noEmit
pnpm run ui:typecheck
node --import tsx/esm --test test/phase14b-*.test.ts
node --import tsx/esm --test test/phase14a-*.test.ts
node --import tsx/esm --test test/phase13-remediation.test.ts test/phase14a-readonly.test.ts test/capability-state-regression.test.ts test/phase12-cli-regression.test.ts test/phase10-mcp.test.ts test/phase11-integration.test.ts
git diff --check
```

The closure task also runs `npm pack --dry-run`, fresh npm and pnpm packed installs, `node .../dist/cli.js --help`, and a fresh-process `code-atlas mcp` initialize exchange. The exact temporary-directory commands are in Track 14B-5.

The implementation worker must use `superpowers:subagent-driven-development` or `superpowers:executing-plans`, create the worktree only at execution time, begin each task with its failing test, commit only task-owned paths, and stop on any dependency ABI/package or semantic conflict rather than substituting an unapproved parser architecture.
