# Phase15B Task Context Compiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic `compile_task_context` service that converts a task into a bounded, evidence-backed list of Phase15A `ContextSubject` references.

**Architecture:** Keep task normalization, candidate collection, rank fusion, budgeting, and orchestration as focused modules under `src/core/context/`. Reuse existing repository status, lexical/hybrid retrieval, indexed graph, change/impact, affected-test, and identity services through thin adapters. MCP and CLI call the same compiler; the compiler never calls `context_read` or renders source.

**Tech Stack:** Node.js 22+, TypeScript, built-in `node:crypto`, existing `node:test`, Zod/MCP SDK, current AtlasStore and indexed graph services, existing CLI reporter/presentation helpers.

**Spec:** `docs/superpowers/specs/2026-09-13-phase15b-task-context-compiler-design.md`

## Global Constraints

- Phase15B decides WHAT context is relevant; Phase15A decides HOW selected content is delivered.
- Reuse exactly the current Phase15A `ContextSubject`: file or symbol only.
- `candidate.exact` means only that the candidate has an exact, deliverable Phase15A `ContextSubject`; it never by itself implies `priority="required"`.
- Required promotion is allowed only for `explicit_anchor`, `explicit_changed_path`, or direct exact task-target resolution represented by `task_exact_resolution`.
- `compile_task_context` must not call `context_read`, return source bodies, or accept session/receipt/history/model/agent inputs.
- Preserve unique-or-drop resolution: malformed anchors are hard errors; valid unresolved/ambiguous anchors are non-exact evidence.
- Use no LLM, generic RAG/memory subsystem, recursive graph traversal, or new mandatory dependency.
- Candidate authority order is explicit anchors, exact resolution, lexical/optional semantic retrieval, bounded one-hop graph, change/impact, affected tests.
- Centralize and version strategy constants; v1 caps are retrieval seeds <= 20, graph neighbors <= 5 per seed, impact candidates <= 10, and affected tests <= 10.
- Use RRF-style rank fusion; never add incompatible raw lexical/vector/graph scores.
- Required subjects are never silently dropped; required overflow keeps them and reports `budgetExceeded=true`.
- `taskIdentity` is a `task-v1:<digest>` over only normalized task text, anchors, changed paths, and identity schema/version.
- `planIdentity` excludes timestamps, timing, randomness, performance measurements, session identity, and receipt identity.
- Optional capability failures degrade the plan and set `mayBeIncomplete`; only invalid input/repository/workspace resolution failures are hard errors.
- Preserve CLI `listr2`, colors, icons, `ProgressReporter`, TTY/non-TTY, and `NO_COLOR` behavior.
- Do not modify or stage `AGENTS.md` or `.worktrees/`; do not push, tag, publish, or release.

## Repository surfaces inspected

The implementation must start from these current APIs rather than assuming design names already exist:

- `src/core/context/context.types.ts`: current `ContextSubject` is exactly file or symbol; `ContextAwareReadResult` and Phase15A identity types are already present.
- `src/core/context/context-identity.ts`: current Phase15A subject validation/identity boundary.
- `src/core/context/context.types.ts`: add the smallest Phase15A-owned export `CONTEXT_SUBJECT_SELECTOR_VERSION = "1"` if no equivalent export exists; do not change `ContextSubject`.
- `src/core/context/context-identity.ts`: `getWorkspaceIdentity`, `canonicalSubjectIdentity`, and stable JSON behavior exist.
- `src/core/context/context-aware-read.service.ts`: `readContextAware(repoPath, request)` is delivery-only and must remain outside compiler calls.
- `src/core/repository/repository-identity.ts`: `canonicalRepositoryPath` and `getRepositoryIdentity` provide current repository identity.
- `src/core/repository/repository-status.service.ts`: `getRepositoryStatusReadOnly(repoPath, providers?)` exposes graph, lexical, semantic, vector, and framework capability state.
- `src/core/lexical/lexical-search.service.ts`: `searchLexical(query, limit, repoPath, filePrefix?)` returns ranked file/symbol metadata and snippets.
- `src/core/retrieval/hybrid-search.service.ts`: `inspectHybridSearch(query, limit, repoPath, providers?)` returns lexical/vector stages, semantic state, and fused results.
- `src/core/retrieval/retrieval-inspector.service.ts`: `inspectRetrieval` is an inspection composition; reuse its result conventions only where needed, not its rendered context budget.
- `src/core/graph/indexed-graph.service.ts`: `loadIndexedGraphReadOnly(repoPath)` returns graph plus capability/freshness metadata.
- `src/core/graph/query/graph-query-entity-resolver.ts`: `resolveGraphEntity(graph, query)` preserves resolved/ambiguous/not_found states.
- `src/core/graph/query/graph-query.service.ts`: `findCallers`, `findCallees`, `findImports`, and `findImportedBy` provide bounded direct relations.
- `src/core/graph/query/impact.service.ts`: `analyzeImpact(graph, query, options)` supports bounded impact with coverage.
- `src/core/change/inspect-change.service.ts`: `inspectChange(repoPath, input?)` returns changed/affected symbols and diagnostics.
- `src/core/change/affected-tests.service.ts`: `affectedTests(repoPath, input?)` returns selected tests, uncovered symbols/files, and incompleteness.
- `src/adapters/mcp/mcp-server.ts`: `registerJsonTool`, `resolveRepo`, and existing bounded JSON tool patterns are the integration seam.
- `src/cli.ts`, `src/adapters/cli/cli-help.ts`, `cli-command-reporter.ts`, and `cli-presentation.ts`: command dispatch, help, deterministic JSON, and human presentation conventions.
- `src/core/context/context-snapshot.ts`, `facts-identity.ts`, `file-hash.ts`, and existing stable JSON helpers: reuse the established SHA-256/stable serialization pattern.
- `src/core/repository/repository-status.service.ts` and AtlasStore generation metadata: status omits generation ids, so the plan must add one read-only helper using existing `AtlasStore.getActiveGenerationId`, `getActiveGenerationVersions`, and `getFileCapabilityStates`.
- `test/phase15a-*.test.ts`, `test/phase14b-*.test.ts`, and `test/helpers/phase14b-language-fixtures.ts`: current node:test, temp-repository, capability, and cross-language fixture conventions.

## File map

- Create `src/core/context/task-context.types.ts`: public input, anchor, evidence, candidate, item, budget, reliability, and plan types.
- Create `src/core/context/task-context-normalizer.ts`: conservative normalization and task identity canonical input.
- Create `src/core/context/task-context-candidates.ts`: authority-ordered collection, exact subject conversion, merge/dedupe, and capability adapters.
- Create `src/core/context/task-context-ranker.ts`: required/supporting/optional rules and deterministic RRF-style ordering.
- Create `src/core/context/task-context-budget.ts`: subject budget selection and conservative cost accounting.
- Create `src/core/context/task-context-compiler.ts`: orchestration, repository/workspace resolution, identities, reliability, and compact/full detail projection.
- Modify `src/core/context/context.types.ts`: baseline does not export the selector constant, so add `CONTEXT_SUBJECT_SELECTOR_VERSION = "1"` there.
- Modify `src/core/repository/repository-status.service.ts` only if needed to expose a read-only generation/version fingerprint for plan identity.
- Create `src/adapters/cli/context-compile.command.ts`: parser and human/JSON inspection output using the shared compiler.
- Modify `src/cli.ts` and `src/adapters/cli/cli-help.ts`: register `context-compile`.
- Modify `src/adapters/mcp/mcp-server.ts`: register `compile_task_context`.
- Create `test/phase15b-*.test.ts`: focused unit, integration, MCP, CLI, and cross-language coverage.
- Create representative fixture files only if existing Phase14B fixtures cannot exercise task-context subject selection without changing unrelated fixtures.

## Candidate authority and dirty-worktree relevance

Collection order is explicit anchors, exact file/symbol resolution, lexical plus
optional semantic/hybrid retrieval, bounded one-hop graph relationships,
change/impact evidence, and affected tests.

An input `changedPaths` entry produces `explicit_changed_path` evidence. If
the normalized repository-relative current file exists and is readable, it
directly produces an exact required file subject. If it is missing or deleted,
retain diagnostic/non-exact evidence and do not fabricate a readable subject.
Repository-discovered change evidence is a separate `change` evidence kind.

`inspectChange` and `affectedTests` inspect working/staged/commit/range
change state, so their output is relevance-gated: it may enrich the plan only
when traceable to an explicit changed path or an already exact required task
subject. Affected tests must retain their affected symbol/file chain. Unrelated
dirty files and their tests are ignored; capability diagnostics may still be
reported.

## Concrete public interfaces

These definitions are locked before implementation and are shared by compiler, adapters, and tests:

```ts
import type { ContextSubject } from "./context.types.js";

export type TaskContextAnchor =
  | { kind: "file"; path: string }
  | { kind: "symbol"; path?: string; name: string };

export type CompileTaskContextInput = {
  task: string;
  repoPath?: string;
  anchors?: TaskContextAnchor[];
  changedPaths?: string[];
  budget?: { maxItems?: number; maxEstimatedTokens?: number };
  detail?: "compact" | "full";
};

export type TaskContextPriority = "required" | "supporting" | "optional";

export type TaskContextEvidence =
  | { kind: "explicit_anchor"; anchor: TaskContextAnchor }
  | { kind: "explicit_changed_path"; path: string }
  | { kind: "task_exact_resolution"; query: string; resolution: "file" | "symbol" }
  | { kind: "lexical"; rank: number; query: string }
  | { kind: "semantic"; rank: number; query: string }
  | { kind: "hybrid"; rank: number; query: string }
  | { kind: "graph"; relation: string; from: string; depth: 1 }
  | { kind: "change"; relation: string; path: string }
  | { kind: "impact"; relation: string; depth: number }
  | { kind: "affected_test"; path: string; confidence?: string }
  | { kind: "diagnostic"; message: string };

export type TaskContextCandidate = {
  subject?: ContextSubject;
  query?: string;
  priorityHint?: TaskContextPriority;
  evidence: TaskContextEvidence[];
  sourceRanks: Partial<Record<TaskContextEvidence["kind"], number>>;
  estimatedTokens?: number;
  exact: boolean;
};

export type TaskContextItem = {
  subject: ContextSubject;
  priority: TaskContextPriority;
  rank: number;
  reasons: string[];
  estimatedTokens?: number;
};

export type TaskContextFullItem = TaskContextItem & {
  scoreSignal: number;
  evidence: TaskContextEvidence[];
  fusion: { sourceRanks: Partial<Record<TaskContextEvidence["kind"], number>> };
};

export type TaskContextBudget = {
  maxItems: number;
  maxEstimatedTokens: number;
  selectedItems: number;
  estimatedTokens: number;
  omittedItems: number;
  budgetExceeded: boolean;
};

export type TaskContextReliability = {
  mayBeIncomplete: boolean;
  capabilityStates: Record<string, string>;
  diagnostics: string[];
};

export type TaskContextPlan = {
  taskIdentity: string;
  planIdentity: string;
  repositoryIdentity: string;
  workspaceIdentity: string;
  items: TaskContextItem[];
  budget: TaskContextBudget;
  reliability: TaskContextReliability;
  capabilityFingerprint: string;
  compiler: { schemaVersion: number; strategyVersion: string };
  projection: {
    detail: "compact" | "full";
    detailsAvailable: boolean;
    omitted: number;
    truncated: boolean;
  };
};

export type TaskContextPlanDetail =
  | { detail: "compact"; plan: TaskContextPlan }
  | {
      detail: "full";
      plan: Omit<TaskContextPlan, "items"> & { items: TaskContextFullItem[] };
      omittedCandidates: TaskContextCandidate[];
      fusion: Record<string, unknown>;
    };

export function compileTaskContext(
  input: CompileTaskContextInput,
): Promise<TaskContextPlanDetail>;
```

The collector/ranker operate on an internal compiled plan containing
`TaskContextFullItem[]`. The compiler projects that plan into compact
`TaskContextItem[]` or full `TaskContextFullItem[]`. Compact never includes
`scoreSignal`, evidence, or fusion metadata. Full-only candidates/evidence are
bounded by strategy caps; `omitted`, `truncated`, and `detailsAvailable`
make response-bound omission deterministic and visible. Neither projection
changes `planIdentity`.

## Task 1: Lock domain contracts and conservative normalization

**Files:**
- Create: `src/core/context/task-context.types.ts`
- Create: `src/core/context/task-context-normalizer.ts`
- Test: `test/phase15b-normalizer.test.ts`
- Test: `test/phase15b-identity.test.ts`

**Interfaces:**
- Produces the types above and `normalizeTaskContextInput(input): NormalizedTaskContextInput`.
- Produces `createTaskIdentity(normalized): string` and `canonicalContextSubjectKey(subject): string`.
- Consumes Phase15A `ContextSubject`, the Phase15A-owned `CONTEXT_SUBJECT_SELECTOR_VERSION`, and existing repository-relative path conventions. Do not use delivery-scoped `canonicalSubjectIdentity(repository, workspace, subject)` for candidate dedupe.

- [ ] Write failing tests for empty task rejection, Unicode NFC, CRLF-to-LF normalization, trimming, conservative whitespace normalization, identifier preservation (`fooBar`, `HTTPServer`, `$value`), sorted/deduplicated anchors, sorted/deduplicated changed paths, and safe relative path rejection.
- [ ] Write failing identity tests proving equivalent normalized inputs produce the same `task-v1:<digest>`, while changing task text, anchor path/name, changed path, or identity schema changes the digest.
- [ ] Write failing tests proving `canonicalContextSubjectKey` hashes only validated file/symbol fields, rejects unsupported variants, and changes when the canonical selector version changes.
- [ ] Run:
  ```bash
  node --import tsx/esm --test test/phase15b-normalizer.test.ts test/phase15b-identity.test.ts
  ```
  Expected: FAIL because the new module exports do not exist.
- [ ] Implement normalization conservatively: require non-empty `task`; normalize to NFC; normalize CRLF/CR to LF; trim outer whitespace; replace only runs of spaces/tabs within each line with one space; preserve line boundaries, punctuation, casing, and identifier characters; normalize paths to repository-relative slash-separated form; sort anchors by kind then path then name and changed paths lexicographically; reject malformed/absolute/traversal paths.
- [ ] Serialize task identity input with fixed keys `schemaVersion`, `task`, `anchors`, `changedPaths`; hash UTF-8 stable JSON using SHA-256; return `task-v1:<hex>`. Do not include repository/workspace, capability, budget, timing, session, or receipt values.
- [ ] Export `CONTEXT_SUBJECT_SELECTOR_VERSION = "1"` from the Phase15A `context.types.ts` module if absent, with the smallest additive constant/helper and no ContextSubject shape change. Use it for every emitted symbol subject; never scatter a literal selector version.
- [ ] Serialize `canonicalContextSubjectKey(subject)` from only validated subject fields: file path, or symbol path/symbolId/selectorVersion. Use delivery-scoped `canonicalSubjectIdentity` only in Phase15A delivery semantics, never for candidate dedupe.
- [ ] Run the focused tests again; expected: PASS.
- [ ] Commit:
  ```bash
  git add src/core/context/context.types.ts src/core/context/task-context.types.ts src/core/context/task-context-normalizer.ts test/phase15b-normalizer.test.ts test/phase15b-identity.test.ts
  git commit -m "feat(context): add task context contracts and normalization"
  ```

## Task 2: Implement evidence merge and candidate model

**Files:**
- Create: `src/core/context/task-context-candidates.ts`
- Test: `test/phase15b-candidates.test.ts`

**Interfaces:**
- Consumes normalized input and current Phase15A subject key.
- Produces `mergeTaskContextCandidates(candidates): TaskContextCandidate[]`.
- Produces internal helpers for exact file subjects, exact symbol subjects, and diagnostic-only non-exact candidates.

- [ ] Write failing tests for duplicate file candidates, duplicate exact symbol candidates, evidence accumulation, evidence dedupe by canonical stable JSON, exact flag preservation, and stable candidate ordering.
- [ ] Add classification tests: malformed anchor throws; valid unresolved file becomes diagnostic/non-exact; valid unresolved symbol becomes non-exact; ambiguous symbol remains non-exact and never gets a `symbolId`.
- [ ] Run:
  ```bash
  node --import tsx/esm --test test/phase15b-candidates.test.ts
  ```
  Expected: FAIL on missing candidate exports.
- [ ] Implement merge keyed only by canonical Phase15A subject key when a subject exists; keep unresolved candidates in diagnostics/omitted evidence without fabricating a subject; dedupe evidence by deterministic canonical JSON and sort evidence by kind/source rank/payload. Define `exact=true` only as exact deliverability of the subject; do not derive required priority from that boolean.
- [ ] Keep `path?: string` only on input anchors. Emitted symbol subjects always contain the Phase15A stable `path`, `symbolId`, and `selectorVersion`.
- [ ] Run the focused test; expected: PASS.
- [ ] Commit:
  ```bash
  git add src/core/context/task-context-candidates.ts test/phase15b-candidates.test.ts
  git commit -m "feat(context): merge task context evidence"
  ```

## Task 3: Add exact and retrieval candidate collection

**Files:**
- Modify: `src/core/context/task-context-candidates.ts`
- Create: `test/phase15b-collection.test.ts`

**Interfaces:**
- Consumes `CompileTaskContextInput`, normalized input, and injected current-service functions.
- Produces:
  ```ts
  type TaskContextCollectionDeps = {
    repositoryPath: string;
    repositoryIdentity: string;
    workspaceIdentity: string;
    getStatus: typeof getRepositoryStatusReadOnly;
    loadGraph: typeof loadIndexedGraphReadOnly;
    lexicalSearch: typeof searchLexical;
    hybridSearch: typeof inspectHybridSearch;
    providers?: RetrievalProviders;
  };
  collectTaskContextCandidates(
    normalized: NormalizedTaskContextInput,
    deps: TaskContextCollectionDeps,
  ): Promise<{ candidates: TaskContextCandidate[]; reliability: TaskContextReliability }>;
  ```

- [ ] Write failing integration tests for explicit file anchor, path-qualified symbol anchor, pathless symbol anchor, direct exact task-target resolution, explicit changed path producing an exact required file, missing changed path producing only diagnostic evidence, lexical-only retrieval, semantic available, semantic unavailable, empty/weak retrieval, and optional retrieval failure.
- [ ] Run the focused collection test; expected: FAIL because the collector is not exported.
- [ ] Implement authority order: validate explicit anchors; resolve files against the already canonical `repositoryPath` and repository-relative existence/index metadata; resolve direct task targets via `resolveGraphEntity` and emit `task_exact_resolution` only for unique direct task resolution; accept only `resolved` entities as exact stable symbol subjects; preserve ambiguous/not_found states as non-exact diagnostics. Process `explicit_changed_path` separately and require current readable-file proof before creating its exact required file subject.
- [ ] Convert retrieval results from `searchLexical`/hybrid stages to file subjects when only file metadata is proven, and symbol subjects only when a matching graph node resolves uniquely; retain source rank and query evidence without copying content bodies.
- [ ] Choose the primitive lexical stream and primitive semantic/vector stream as the only RRF scoring streams. When using `inspectHybridSearch`, consume its lexical/vector stage ranks and fused result only as provenance/diagnostic metadata; never add a separate hybrid rank contribution.
- [ ] Cap retrieval seed inputs to 20 and result candidates to the centralized strategy cap. Catch semantic/provider failures, record capability diagnostics, and continue with lexical/exact evidence.
- [ ] Derive capability states from `getRepositoryStatusReadOnly` and retrieval stage state; set `mayBeIncomplete` for stale, error, unavailable, not-indexed, truncated, or missing capability evidence where absence would otherwise be inferred.
- [ ] Run focused tests; expected: PASS.
- [ ] Commit:
  ```bash
  git add src/core/context/task-context-candidates.ts test/phase15b-collection.test.ts
  git commit -m "feat(context): collect exact and retrieval candidates"
  ```

## Task 4: Add bounded graph, change/impact, and affected-test enrichment

**Files:**
- Modify: `src/core/context/task-context-candidates.ts`
- Test: `test/phase15b-enrichment.test.ts`

**Interfaces:**
- Consumes exact required candidates and the injected graph/change/test services.
- Produces enriched candidates through the same collector result; no new public subject type.
- Uses current `findCallers`, `findCallees`, `findImports`, `findImportedBy`, `analyzeImpact`, `inspectChange`, and `affectedTests` APIs.

- [ ] Write failing tests for direct one-hop callers/callees/imports, graph fan-out cap of 5 per required seed, no second-hop expansion, impact cap of 10, affected-test cap of 10, unrelated dirty file exclusion, relevance through an explicit changed path, relevance through an exact required subject, no-overlap exclusion, and unavailable graph/change/test capabilities.
- [ ] Run:
  ```bash
  node --import tsx/esm --test test/phase15b-enrichment.test.ts
  ```
  Expected: FAIL on missing bounded enrichment behavior.
- [ ] Implement graph enrichment only from exact required subjects, resolve related nodes to file or exact symbol subjects, sort by current graph relation ordering plus canonical subject key, and stop after one hop.
- [ ] Implement change/impact enrichment through current service results only after tracing each result to an explicit changed path or exact required subject. Ignore unrelated working-tree/staged/commit/range candidates; never treat missing stale/incomplete results as negative evidence. Convert affected test files to file subjects and preserve the affected symbol/file chain; do not mark a test required solely because it is related.
- [ ] Centralize `strategyVersion = "task-context-v1"`, `maxRetrievalSeeds = 20`, `maxGraphNeighborsPerSeed = 5`, `maxImpactCandidates = 10`, `maxAffectedTests = 10`, `maxFullOmittedCandidates = 20`, `maxFullEvidencePerItem = 8`, `symbolTokensPerLine = 4`, `bytesPerEstimatedToken = 4`, and `unknownEstimatedTokens = 256`; include these constants in strategy-owned diagnostics, not task identity.
- [ ] Catch each optional source independently and merge diagnostics/capability states. Only invalid repository/workspace resolution propagates as a hard error.
- [ ] Run the focused test; expected: PASS.
- [ ] Commit:
  ```bash
  git add src/core/context/task-context-candidates.ts test/phase15b-enrichment.test.ts
  git commit -m "feat(context): add bounded task context enrichment"
  ```

## Task 5: Implement deterministic ranking and priority rules

**Files:**
- Create: `src/core/context/task-context-ranker.ts`
- Test: `test/phase15b-ranker.test.ts`

**Interfaces:**
- Produces:
  ```ts
  rankTaskContextCandidates(
    candidates: TaskContextCandidate[],
  ): TaskContextFullItem[];
  ```
- Consumes candidate evidence and strategy constants; performs no I/O.

- [ ] Write failing table-driven tests for required explicit/direct-task-exact/changed candidates, supporting direct neighbors/corroborated retrieval/affected tests, optional weak or one-source candidates, ambiguous non-required candidates, and exact-over-fuzzy dominance. Prove a lexical fuzzy candidate that maps uniquely to an exact symbol has `exact=true` but is not automatically required, while a direct task target with `task_exact_resolution` is required.
- [ ] Run:
  ```bash
  node --import tsx/esm --test test/phase15b-ranker.test.ts
  ```
  Expected: FAIL because the ranker is not implemented.
- [ ] Implement priority as a rule-first decision: only explicit anchors, explicit changed paths, and direct task resolution carrying `task_exact_resolution` are required; exactness alone never promotes a candidate. Direct graph neighbors, corroborated retrieval, and directly affected tests are supporting; weak/one-source evidence is optional; unresolved/ambiguous evidence cannot be required. Retrieval candidates remain budgeted even when their subject is exactly addressable.
- [ ] Compute source ranks independently for lexical, semantic/vector, graph, impact, change, and affected-test streams. Use `1 / (60 + sourceRank)` for each contributing stream; hybrid/fused is metadata only and contributes zero. Add a test proving one hybrid result is not double/triple-counted.
- [ ] Dedupe reasons and evidence deterministically; rank by priority tier, descending fused signal, exact flag, evidence count, then canonical subject key. Assign one-based rank after final ordering.
- [ ] Return stable short reasons such as `explicit anchor`, `exact symbol resolution`, `lexical match rank N`, `direct graph caller`, or `affected test`; do not emit probability/confidence claims.
- [ ] Run the focused tests; expected: PASS.
- [ ] Commit:
  ```bash
  git add src/core/context/task-context-ranker.ts test/phase15b-ranker.test.ts
  git commit -m "feat(context): add deterministic task context ranking"
  ```

## Task 6: Implement subject budgeting and conservative token estimates

**Files:**
- Create: `src/core/context/task-context-budget.ts`
- Test: `test/phase15b-budget.test.ts`

**Interfaces:**
- Produces:
  ```ts
  budgetTaskContext(
    items: TaskContextFullItem[],
    request?: CompileTaskContextInput["budget"],
  ): { items: TaskContextFullItem[]; budget: TaskContextBudget; diagnostics: string[] };
  ```
- Consumes ranked `TaskContextFullItem[]` and optional indexed/source-span/file metadata; never reads full source merely to count tokens.

- [ ] Write failing tests for max-items selection, max-estimated-tokens selection, required/supporting/optional order, omitted count, unknown cost handling, required overflow, and an exact-addressable retrieval candidate being budgeted as supporting/optional rather than bypassing the budget.
- [ ] Run:
  ```bash
  node --import tsx/esm --test test/phase15b-budget.test.ts
  ```
  Expected: FAIL because the budgeter is not implemented.
- [ ] Implement defaults as centralized strategy values; validate positive finite integer limits and reject invalid budget input.
- [ ] Lock strategy-owned estimates: symbol = `max(1, endLine - startLine + 1) * 4` estimated tokens; file = `ceil(byteSize / 4)` from stat/index metadata; unknown = `256` estimated tokens. Record `estimateKind: "symbol_span" | "file_bytes" | "unknown_fallback"` internally, keep all constants under `task-context-v1`, and never call a source renderer.
- [ ] Select required first, then supporting, then optional; within each tier use rank order. Keep every required item even when it exceeds either budget, set `budgetExceeded=true`, and add a diagnostic.
- [ ] Return deterministic selected/omitted counts and estimated total; never silently drop a valid required subject.
- [ ] Run the focused tests; expected: PASS.
- [ ] Commit:
  ```bash
  git add src/core/context/task-context-budget.ts test/phase15b-budget.test.ts
  git commit -m "feat(context): budget task context subjects"
  ```

## Task 7: Orchestrate compiler and deterministic identities/reliability

**Files:**
- Create: `src/core/context/task-context-compiler.ts`
- Modify: `src/core/repository/repository-status.service.ts` to expose the read-only capability fingerprint
- Test: `test/phase15b-compiler.test.ts`
- Test: `test/phase15b-identity-integration.test.ts`
- Test: `test/phase15b-phase15a-compatibility.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export async function compileTaskContext(
    input: CompileTaskContextInput,
    deps?: TaskContextCompilerDeps,
  ): Promise<TaskContextPlanDetail>;
  ```
- `TaskContextCompilerDeps` injects repository/workspace resolvers, candidate collection, ranking, budgeting, status, and optional providers for deterministic unit tests.
- Consumes `createTaskIdentity`, `getRepositoryIdentity`, `getWorkspaceIdentity`, and the prior task modules.

- [ ] Write failing tests for compact default, full detail, invalid input, repository/workspace resolution failure, empty/weak plan, optional capability failure, and no `context_read` invocation.
- [ ] Write the real compatibility RED test now: compile a file task and a symbol task, pass each emitted subject directly to the existing Phase15A read request, and assert no translation/adaptation or compiler-side `readContextAware` call is needed.
- [ ] Write identity tests proving task identity excludes repository/index generation, capability state, budget, runtime timing, session, and receipt; proving plan identity includes repository/workspace identity, strategy/schema versions, selected subjects/order/priority, budget result, and the exact stable capability/generation fingerprint.
- [ ] Run:
  ```bash
  node --import tsx/esm --test test/phase15b-compiler.test.ts test/phase15b-identity-integration.test.ts test/phase15b-phase15a-compatibility.test.ts
  ```
  Expected: FAIL because orchestration and identity composition are not implemented.
- [ ] Resolve and canonicalize repository/workspace before collection; propagate only validated resolution failures as hard errors.
- [ ] Compute task identity once from normalized task inputs. Compute plan identity from fixed-key stable JSON in this exact order: `schemaVersion`, `strategyVersion`, `taskIdentity`, `repositoryIdentity`, `workspaceIdentity`, `capabilityFingerprint`, `selectedItems`, `budget`. Within `selectedItems`, sort by final item order and include subject key, priority, rank, and estimate. Exclude diagnostics, detail selector, timestamps, timing, session, receipt, and source content.
- [ ] Add or consume the read-only `getTaskContextCapabilityFingerprint(repoPath)` helper. Open AtlasStore read-only and use `getActiveGenerationId(repoId)`, `getActiveGenerationVersions(repoId)`, and `getFileCapabilityStates(repoId, "semantic")`; combine those with status capability/version/provider fields into fixed sorted keys: active generation id, version domains, semantic file generation/provider pairs, and capability states. Omit `updatedAt`, timings, item counts, error text, raw source, and performance data. Add tests for same generation/same identity, changed relevant generation/changed identity, and timestamp-only change/same identity.
- [ ] Merge reliability from status and every collector source: `mayBeIncomplete` is the OR of stale/incomplete/unavailable/error/truncated states; `capabilityStates` is a sorted key/value map; diagnostics are deduped and sorted.
- [ ] Return compact by default with compact items only. Full projection may expose full items, complete bounded evidence, fusion fields, omitted candidates, and budget decisions. Cap full-only omitted candidates at 20 and evidence entries at 8 per item; expose `detailsAvailable`, `omitted`, and `truncated` metadata when caps omit data. Keep projection metadata out of plan identity.
- [ ] Run focused tests; expected: PASS.
- [ ] Commit:
  ```bash
  git add src/core/context/task-context-compiler.ts src/core/repository/repository-status.service.ts test/phase15b-compiler.test.ts test/phase15b-identity-integration.test.ts test/phase15b-phase15a-compatibility.test.ts
  git commit -m "feat(context): compile task context plans"
  ```

## Task 8: Verify Phase15A compatibility and compiler boundary

**Files:**
- Review: `test/phase15b-phase15a-compatibility.test.ts`

**Interfaces:**
- Consumes `compileTaskContext` and the existing `readContextAware` request contract.
- Produces no adapter layer: every emitted Phase15B v1 subject is passed directly to Phase15A `context_read`/read service after the caller supplies its explicit delivery session/generation.

- [ ] Re-run the compatibility test created in Task 7 after the compiler implementation:
  ```bash
  node --import tsx/esm --test test/phase15b-phase15a-compatibility.test.ts
  ```
-  Expected: PASS; this is verification, not a new RED task.
- [ ] Review the diff and assert both emitted subject kinds are accepted directly, selectorVersion is canonical, and compiler execution itself did not call `readContextAware`; make no production change in this task.
- No production change or separate commit is needed: the compatibility RED/GREEN
  test belongs to Task 7 and is re-run here as a verification checkpoint.

## Task 9: Add MCP tool and bounded projections

**Files:**
- Modify: `src/adapters/mcp/mcp-server.ts`
- Test: `test/phase15b-mcp.test.ts`

**Interfaces:**
- MCP input schema:
  ```ts
  {
    task: string;
    repoPath?: string;
    anchors?: Array<
      | { kind: "file"; path: string }
      | { kind: "symbol"; path?: string; name: string }
    >;
    changedPaths?: string[];
    budget?: { maxItems?: number; maxEstimatedTokens?: number };
    detail?: "compact" | "full";
  }
  ```
- Handler calls only `compileTaskContext`; it uses existing `registerJsonTool` and returns deterministic JSON.

- [ ] Write failing MCP tests for registration, compact default, full detail, structured anchors, invalid anchor shape, bounded output, no source body, no `sessionId`/`receiptId`/history/model/agent fields, and no context DB/read side effect.
- [ ] Run:
  ```
  node --import tsx/esm --test test/phase15b-mcp.test.ts
  ```
  Expected: FAIL because the tool is not registered.
- [ ] Register `compile_task_context` beside existing repository/search/context tools with strict Zod input. Use `resolveRepo` and optional providers only through the compiler dependency boundary.
- [ ] Return compact fields by default and expose full evidence/fusion/omitted/budget diagnostics only for `detail="full"`; never include retrieval content/source bodies.
- [ ] Preserve protocol-only stdout and existing MCP error translation; optional capability failures must be represented in the plan, not thrown as internal errors.
- [ ] Run focused MCP tests plus existing MCP protocol tests; expected: PASS.
- [ ] Commit:
  ```bash
  git add src/adapters/mcp/mcp-server.ts test/phase15b-mcp.test.ts
  git commit -m "feat(mcp): expose task context compiler"
  ```

## Task 10: Add CLI inspection command and presentation

**Files:**
- Create: `src/adapters/cli/context-compile.command.ts`
- Modify: `src/cli.ts`
- Modify: `src/adapters/cli/cli-help.ts`
- Test: `test/phase15b-cli.test.ts`

**Interfaces:**
- Produces `parseContextCompileArgs(args): { repoPath: string; json: boolean; input: CompileTaskContextInput }`.
- Produces `formatContextCompile(plan): string` and `runContextCompileCommand(args): Promise<void>`.
- Calls the same `compileTaskContext` service used by MCP.

- [ ] Write failing tests for `context-compile --task "..."`, `--json`, anchors, changed paths, budget flags, human output, non-TTY output, deterministic repeated JSON, and invalid input.
- [ ] Run:
  ```
  node --import tsx/esm --test test/phase15b-cli.test.ts
  ```
  Expected: FAIL because parser/dispatch/help entries do not exist.
- [ ] Implement strict argument parsing with repository path positional, `--task`, repeatable structured anchor flags, changed paths, budget flags, `--full`, and `--json`; reject unknown/malformed values before calling the compiler.
- [ ] Add `context-compile` dispatch in `src/cli.ts` and help text in the existing command groups. Use `createCliCommandReporter`, `formatCommandFailure`, and existing presentation helpers; do not add a second compiler or progress system.
- [ ] Ensure human output is concise and JSON output is deterministic/ANSI-free in TTY and non-TTY environments.
- [ ] Run focused CLI tests plus existing CLI startup/help/format tests; expected: PASS.
- [ ] Commit:
  ```bash
  git add src/adapters/cli/context-compile.command.ts src/cli.ts src/adapters/cli/cli-help.ts test/phase15b-cli.test.ts
  git commit -m "feat(cli): add task context inspection"
  ```

## Task 11: Cross-language fixtures, evaluation gates, and regression closure

**Files:**
- Create: `test/phase15b-cross-language.test.ts`
- Create: `test/phase15b-evaluation.test.ts`
- Reuse: existing Phase14B fixture/helper files; add no fixture/helper production changes unless a concrete test requires one
- Review: all `src/core/context/task-context-*.ts`, MCP/CLI adapters, and Phase15A tests

**Interfaces:**
- Consumes the public compiler, MCP, CLI, and existing Phase14B fixture conventions.
- Produces repeatable regression/evaluation evidence without changing runtime ranking from evaluation results.

- [ ] Add cross-language verification tests for representative TypeScript, Python, Java or Kotlin, and Go or Rust repositories. Each fixture must compile explicit file and symbol tasks and assert file/symbol subjects only; use existing language fixture helpers where practical.
- [ ] Add integration coverage for lexical-only, semantic available/unavailable, one-hop graph, stale/incomplete graph, change/impact, affected tests, optional source failure, empty/weak plan, and required budget overflow.
- [ ] Add hard evaluation assertions: explicit exact target hit = 100%; deterministic repeatability = 100%; ambiguous false-required promotion = 0%; required silently dropped by budget = 0%. Do not add a Context Precision threshold.
- [ ] Run the completed evaluation/closure tests:
  ```
  node --import tsx/esm --test test/phase15b-cross-language.test.ts test/phase15b-evaluation.test.ts
  ```
  Expected: PASS. If new evaluation coverage exposes a gap, fix that gap in the owning task and rerun this verification; do not label an existing behavior test as a required RED step.
- [ ] Add only fixture/test support needed to exercise existing language-neutral graph/parser/index behavior; do not add TypeScript-specific branches to the compiler.
- [ ] If evaluation exposes a production or helper defect, move that correction to its owning task, add the exact changed path to that task's Files and git-add command, and commit it there before returning to this closure task. Do not leave an owning fix unstaged.
- [ ] Run the focused Phase15B suite, existing Phase15A suite, MCP/CLI regressions, and then:
  ```
  pnpm exec tsc --noEmit
  pnpm exec eslint .
  pnpm test
  git diff --check
  ```
  Expected: all relevant commands PASS; if the full suite is environment-blocked, record the exact blocker rather than relabeling it as a pass.
- [ ] Inspect the complete diff and ensure no Phase15C lifecycle, generic memory, delivery, session, receipt, or unsupported subject variant entered the implementation.
- [ ] Commit:
  ```
  git add test/phase15b-cross-language.test.ts test/phase15b-evaluation.test.ts
  git commit -m "test(context): close Phase15B evaluation coverage"
  ```

## Dependency/order summary

```text
1 contracts + normalization
  → 2 candidate merge
  → 3 exact/retrieval collection
  → 4 graph/change/test enrichment
  → 5 ranker
  → 6 budgeter
  → 7 compiler + identity/reliability
  → 8 Phase15A compatibility proof
  → 9 MCP
  → 10 CLI
  → 11 cross-language/evaluation/regression closure
```

Each implementation task has a failing test, a bounded implementation, a focused
green command, and a focused commit. Task 8 is an explicit post-implementation
compatibility verification checkpoint; the final task is evaluation/closure
verification and does not claim a new RED state. The public compiler is usable
after Task 7; adapters are added only after the core contract and direct
Phase15A compatibility are proven.

## Final verification checklist

- [ ] Only file and symbol Phase15A subjects are emitted.
- [ ] Explicit/path-qualified exact targets hit 100%; ambiguous symbols are never required.
- [ ] Task identity is exactly independent of repository/index/capability/budget/timing/session/receipt.
- [ ] Plan identity is deterministic and includes the stated concrete plan inputs.
- [ ] Required subjects are never silently dropped.
- [ ] Graph traversal is one-hop and caps are enforced before budgeting.
- [ ] Positive stale evidence remains usable with diagnostics; missing stale evidence is not absence.
- [ ] Optional failures degrade instead of crashing compilation.
- [ ] Compiler never calls `context_read` or returns source bodies.
- [ ] MCP and CLI share one compiler and produce bounded deterministic JSON.
- [ ] Direct Phase15A integration accepts every emitted subject without translation.
- [ ] Cross-language fixtures cover TypeScript, Python, Java/Kotlin, and Go/Rust.
- [ ] No Phase15C lifecycle or generic memory behavior is present.
- [ ] Full relevant validation, `git diff --check`, and final Git status are recorded.
- [ ] Before every focused commit, `git status --short` shows only that task's
  listed files staged; `AGENTS.md` and `.worktrees/` remain unstaged and no
  unrelated dirty file is carried into the commit.
- [ ] Candidate `exact=true` is never treated as required without
  `explicit_anchor`, `explicit_changed_path`, or
  `task_exact_resolution`; exact-addressable retrieval candidates still pass
  through ranking and budgeting.
