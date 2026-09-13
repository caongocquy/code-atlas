# Phase15B Task Context Compiler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a deterministic `compile_task_context` service that converts a task into a bounded, evidence-backed list of Phase15A `ContextSubject` references.

**Architecture:** Keep task normalization, candidate collection, rank fusion, budgeting, and orchestration as focused modules under `src/core/context/`. Reuse existing repository status, lexical/hybrid retrieval, indexed graph, change/impact, affected-test, and identity services through thin adapters. MCP and CLI call the same compiler; the compiler never calls `context_read` or renders source.

**Tech Stack:** Node.js 22+, TypeScript, built-in `node:crypto`, existing `node:test`, Zod/MCP SDK, current AtlasStore and indexed graph services, existing CLI reporter/presentation helpers.

**Spec:** `docs/superpowers/specs/2026-09-13-phase15b-task-context-compiler-design.md`

## Global Constraints

- Phase15B decides WHAT context is relevant; Phase15A decides HOW selected content is delivered.
- Reuse exactly the current Phase15A `ContextSubject`: file or symbol only.
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
- `test/phase15a-*.test.ts`, `test/phase14b-*.test.ts`, and `test/helpers/phase14b-language-fixtures.ts`: current node:test, temp-repository, capability, and cross-language fixture conventions.

## File map

- Create `src/core/context/task-context.types.ts`: public input, anchor, evidence, candidate, item, budget, reliability, and plan types.
- Create `src/core/context/task-context-normalizer.ts`: conservative normalization and task identity canonical input.
- Create `src/core/context/task-context-candidates.ts`: authority-ordered collection, exact subject conversion, merge/dedupe, and capability adapters.
- Create `src/core/context/task-context-ranker.ts`: required/supporting/optional rules and deterministic RRF-style ordering.
- Create `src/core/context/task-context-budget.ts`: subject budget selection and conservative cost accounting.
- Create `src/core/context/task-context-compiler.ts`: orchestration, repository/workspace resolution, identities, reliability, and compact/full detail projection.
- Create `src/adapters/cli/context-compile.command.ts`: parser and human/JSON inspection output using the shared compiler.
- Modify `src/cli.ts` and `src/adapters/cli/cli-help.ts`: register `context-compile`.
- Modify `src/adapters/mcp/mcp-server.ts`: register `compile_task_context`.
- Create `test/phase15b-*.test.ts`: focused unit, integration, MCP, CLI, and cross-language coverage.
- Create representative fixture files only if existing Phase14B fixtures cannot exercise task-context subject selection without changing unrelated fixtures.

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
  | { kind: "exact_resolution"; query: string; resolution: "file" | "symbol" }
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
  scoreSignal: number;
  reasons: string[];
  evidence: TaskContextEvidence[];
  estimatedTokens?: number;
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
  compiler: { schemaVersion: number; strategyVersion: string };
};

export type TaskContextPlanDetail =
  | { detail: "compact"; plan: TaskContextPlan }
  | { detail: "full"; plan: TaskContextPlan; omittedCandidates: TaskContextCandidate[]; fusion: Record<string, unknown> };

export function compileTaskContext(
  input: CompileTaskContextInput,
): Promise<TaskContextPlanDetail>;
```

The compiler returns `TaskContextPlanDetail`; compact is the default and full
adds bounded candidate/fusion metadata. The public MCP/CLI output remains
JSON-serializable and bounded. The plan identity is computed from the underlying
plan fields, never from the detail selector.

## Task 1: Lock domain contracts and conservative normalization

**Files:**
- Create: `src/core/context/task-context.types.ts`
- Create: `src/core/context/task-context-normalizer.ts`
- Test: `test/phase15b-normalizer.test.ts`
- Test: `test/phase15b-identity.test.ts`

**Interfaces:**
- Produces the types above and `normalizeTaskContextInput(input): NormalizedTaskContextInput`.
- Produces `createTaskIdentity(normalized): string` and `canonicalSubjectKey(subject): string`.
- Consumes Phase15A `ContextSubject`, `canonicalSubjectIdentity`, and existing repository-relative path conventions.

- [ ] Write failing tests for empty task rejection, Unicode NFC, CRLF-to-LF normalization, trimming, conservative whitespace normalization, identifier preservation (`fooBar`, `HTTPServer`, `$value`), sorted/deduplicated anchors, sorted/deduplicated changed paths, and safe relative path rejection.
- [ ] Write failing identity tests proving equivalent normalized inputs produce the same `task-v1:<digest>`, while changing task text, anchor path/name, changed path, or identity schema changes the digest.
- [ ] Run:
  ```bash
  node --import tsx/esm --test test/phase15b-normalizer.test.ts test/phase15b-identity.test.ts
  ```
  Expected: FAIL because the new module exports do not exist.
- [ ] Implement normalization conservatively: require non-empty `task`; normalize to NFC; normalize CRLF/CR to LF; trim outer whitespace; replace only runs of spaces/tabs within each line with one space; preserve line boundaries, punctuation, casing, and identifier characters; normalize paths to repository-relative slash-separated form; sort anchors by kind then path then name and changed paths lexicographically; reject malformed/absolute/traversal paths.
- [ ] Serialize task identity input with fixed keys `schemaVersion`, `task`, `anchors`, `changedPaths`; hash UTF-8 stable JSON using SHA-256; return `task-v1:<hex>`. Do not include repository/workspace, capability, budget, timing, session, or receipt values.
- [ ] Serialize the Phase15A subject key with fixed subject fields and no source body; support only file and symbol and reject every other kind.
- [ ] Run the focused tests again; expected: PASS.
- [ ] Commit:
  ```bash
  git add src/core/context/task-context.types.ts src/core/context/task-context-normalizer.ts test/phase15b-normalizer.test.ts test/phase15b-identity.test.ts
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
- [ ] Implement merge keyed only by canonical Phase15A subject key when a subject exists; keep unresolved candidates in diagnostics/omitted evidence without fabricating a subject; dedupe evidence by deterministic canonical JSON and sort evidence by kind/source rank/payload.
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
    resolveRepo: (repoPath: string) => string;
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

- [ ] Write failing integration tests for explicit file anchor, path-qualified symbol anchor, pathless symbol anchor, exact task target resolution, lexical-only retrieval, semantic available, semantic unavailable, empty/weak retrieval, and optional retrieval failure.
- [ ] Run the focused collection test; expected: FAIL because the collector is not exported.
- [ ] Implement authority order: validate explicit anchors; resolve files by repository-relative existence/index metadata; resolve symbols via `resolveGraphEntity`; accept only `resolved` entities as exact stable symbol subjects; preserve ambiguous/not_found states as non-exact diagnostics.
- [ ] Convert retrieval results from `searchLexical`/hybrid stages to file subjects when only file metadata is proven, and symbol subjects only when a matching graph node resolves uniquely; retain source rank and query evidence without copying content bodies.
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

- [ ] Write failing tests for direct one-hop callers/callees/imports, graph fan-out cap of 5 per required seed, no second-hop expansion, impact cap of 10, affected-test cap of 10, changed-path enrichment, and unavailable graph/change/test capabilities.
- [ ] Run:
  ```bash
  node --import tsx/esm --test test/phase15b-enrichment.test.ts
  ```
  Expected: FAIL on missing bounded enrichment behavior.
- [ ] Implement graph enrichment only from exact required subjects, resolve related nodes to file or exact symbol subjects, sort by current graph relation ordering plus canonical subject key, and stop after one hop.
- [ ] Implement change/impact enrichment through current service results; never treat missing stale/incomplete results as negative evidence. Convert affected test files to file subjects and preserve test evidence; do not mark a test required solely because it is related.
- [ ] Centralize `strategyVersion = "task-context-v1"`, `maxRetrievalSeeds = 20`, `maxGraphNeighborsPerSeed = 5`, `maxImpactCandidates = 10`, and `maxAffectedTests = 10`; include these constants in strategy-owned diagnostics, not task identity.
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
  ): TaskContextItem[];
  ```
- Consumes candidate evidence and strategy constants; performs no I/O.

- [ ] Write failing table-driven tests for required explicit/exact/changed candidates, supporting direct neighbors/corroborated retrieval/affected tests, optional weak or one-source candidates, ambiguous non-required candidates, and exact-over-fuzzy dominance.
- [ ] Run:
  ```bash
  node --import tsx/esm --test test/phase15b-ranker.test.ts
  ```
  Expected: FAIL because the ranker is not implemented.
- [ ] Implement priority as a rule-first decision: explicit anchors, exact resolution, and explicit changed targets are required; direct graph neighbors, corroborated retrieval, and directly affected tests are supporting; weak/one-source evidence is optional; unresolved/ambiguous evidence cannot be required.
- [ ] Compute source ranks independently per evidence stream. Use `1 / (60 + sourceRank)` for each lexical, semantic, hybrid, graph, impact, change, or test stream contribution; use explicit/exact dominance as a priority rule, never raw-score addition across sources.
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
    items: TaskContextItem[],
    request?: CompileTaskContextInput["budget"],
  ): { items: TaskContextItem[]; budget: TaskContextBudget; diagnostics: string[] };
  ```
- Consumes ranked subject references and optional indexed/source-span/file metadata; never reads full source merely to count tokens.

- [ ] Write failing tests for max-items selection, max-estimated-tokens selection, required/supporting/optional order, omitted count, unknown cost handling, and required overflow.
- [ ] Run:
  ```bash
  node --import tsx/esm --test test/phase15b-budget.test.ts
  ```
  Expected: FAIL because the budgeter is not implemented.
- [ ] Implement defaults as centralized strategy values; validate positive finite integer limits and reject invalid budget input.
- [ ] Use item metadata when available: symbol span line count or indexed file metadata multiplied by a documented fixed token-per-line estimate; otherwise use a deterministic bounded unknown-cost marker and conservative fixed estimate. Mark the estimate as an estimate in diagnostics/metadata; never call a source renderer.
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
- Test: `test/phase15b-compiler.test.ts`
- Test: `test/phase15b-identity-integration.test.ts`

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
- [ ] Write identity tests proving task identity excludes repository/index generation, capability state, budget, runtime timing, session, and receipt; proving plan identity includes repository/workspace identity, strategy/schema versions, selected subjects/order/priority, budget result, and relevant capability state/generation.
- [ ] Run:
  ```bash
  node --import tsx/esm --test test/phase15b-compiler.test.ts test/phase15b-identity-integration.test.ts
  ```
  Expected: FAIL because orchestration and identity composition are not implemented.
- [ ] Resolve and canonicalize repository/workspace before collection; propagate only validated resolution failures as hard errors.
- [ ] Compute task identity once from normalized task inputs. Compute plan identity from fixed-key stable JSON in this exact order: `schemaVersion`, `strategyVersion`, `taskIdentity`, `repositoryIdentity`, `workspaceIdentity`, `capabilityStates`, `selectedItems`, `budget`. Exclude diagnostics, timestamps, timing, session, receipt, and source content.
- [ ] Merge reliability from status and every collector source: `mayBeIncomplete` is the OR of stale/incomplete/unavailable/error/truncated states; `capabilityStates` is a sorted key/value map; diagnostics are deduped and sorted.
- [ ] Return compact by default with identities, selected items (short reasons), budget summary, and reliability. Full detail may expose complete evidence, fusion fields, omitted candidates, budget decisions, and diagnostics, but remains bounded and body-free.
- [ ] Run focused tests; expected: PASS.
- [ ] Commit:
  ```bash
  git add src/core/context/task-context-compiler.ts test/phase15b-compiler.test.ts test/phase15b-identity-integration.test.ts
  git commit -m "feat(context): compile task context plans"
  ```

## Task 8: Add direct Phase15A compatibility integration

**Files:**
- Modify: `src/core/context/task-context-compiler.ts` only if a typed adapter is needed
- Test: `test/phase15b-phase15a-compatibility.test.ts`

**Interfaces:**
- Consumes `compileTaskContext` and the existing `readContextAware` request contract.
- Produces no adapter layer: every emitted Phase15B v1 subject is passed directly to Phase15A `context_read`/read service after the caller supplies its explicit delivery session/generation.

- [ ] Write a failing integration test that compiles a file-anchor task and passes the emitted `{ kind: "file"; path }` subject directly into the existing Phase15A read request.
- [ ] Add a symbol-anchor fixture and repeat the test with the emitted `{ kind: "symbol"; path; symbolId; selectorVersion }` subject.
- [ ] Run:
  ```bash
  node --import tsx/esm --test test/phase15b-phase15a-compatibility.test.ts
  ```
  Expected: FAIL if compiler output needs translation or the integration is absent.
- [ ] Implement only type-level/request-shape alignment; do not add a conversion function, range variant, session inference, or delivery call inside the compiler.
- [ ] Assert both emitted subject kinds are accepted directly and that compiler execution itself did not call `readContextAware`.
- [ ] Run the focused test; expected: PASS.
- [ ] Commit:
  ```bash
  git add test/phase15b-phase15a-compatibility.test.ts
  git commit -m "test(context): prove Phase15A subject compatibility"
  ```

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
- [ ] Add `context-compile` dispatch in `src/cli.ts\) and help text in the existing command groups. Use `createCliCommandReporter\), `formatCommandFailure\), and existing presentation helpers; do not add a second compiler or progress system.
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
- Modify: existing fixture/helper only when required by the tests
- Review: all `src/core/context/task-context-*.ts`, MCP/CLI adapters, and Phase15A tests

**Interfaces:**
- Consumes the public compiler, MCP, CLI, and existing Phase14B fixture conventions.
- Produces repeatable regression/evaluation evidence without changing runtime ranking from evaluation results.

- [ ] Write failing cross-language tests for representative TypeScript, Python, Java or Kotlin, and Go or Rust repositories. Each fixture must compile explicit file and symbol tasks and assert file/symbol subjects only; use existing language fixture helpers where practical.
- [ ] Add integration coverage for lexical-only, semantic available/unavailable, one-hop graph, stale/incomplete graph, change/impact, affected tests, optional source failure, empty/weak plan, and required budget overflow.
- [ ] Add hard evaluation assertions: explicit exact target hit = 100%; deterministic repeatability = 100%; ambiguous false-required promotion = 0%; required silently dropped by budget = 0%. Do not add a Context Precision threshold.
- [ ] Run:
  ```
  node --import tsx/esm --test test/phase15b-cross-language.test.ts test/phase15b-evaluation.test.ts
  ```
  Expected: FAIL until the complete compiler and adapters are present.
- [ ] Implement only fixture/test support needed to exercise existing language-neutral graph/parser/index behavior; do not add TypeScript-specific branches to the compiler.
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

Each task has a failing test, a bounded implementation, a focused green command,
and a focused commit. The public compiler is usable after Task 7; adapters are
added only after the core contract and direct Phase15A compatibility are proven.

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
