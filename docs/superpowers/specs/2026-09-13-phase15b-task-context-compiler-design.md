# Phase15B — Task Context Compiler

**Status:** Approved design specification

**Scope:** Compile a coding task into the minimum evidence-backed set of
`ContextSubject` values that an agent should inspect. Phase15B decides **what
context is relevant**. Phase15A remains responsible for **how selected context
is delivered** (`full`, `unchanged`, `delta`, or `rehydrate`).

Phase15B is a planning and selection layer. It does not read or render source
content, persist agent/session memory, or add an LLM dependency.

## 1. Goals and boundaries

Given a task and an optional repository/workspace scope, produce a bounded,
deterministic, explainable `TaskContextPlan` containing exact or
evidence-backed `ContextSubject` references.

The compiler must:

- prioritize explicit and uniquely resolved task targets;
- combine lexical, optional semantic, graph, change/impact, and test evidence;
- preserve unique-or-drop ambiguity behavior;
- expose incomplete or unavailable capabilities;
- select subjects before Phase15A performs delivery;
- remain usable when optional capabilities fail.

The compiler must not:

- call `context_read` or return full source content;
- infer a `ContextSession` from a task or `taskIdentity`;
- accept or depend on `sessionId`, `receiptId`, history, model name, or agent name;
- replace primitive search, graph, impact, or read APIs;
- recursively walk the graph or guess ambiguous symbol identities;
- introduce an internal LLM, model download, external service, or mandatory vector database.

Phase15A remains the authority for `ContextSubject` shape and exact delivery.
Phase15B reuses that contract rather than defining a parallel subject type.

## 2. Architecture

```text
task
  ↓
TaskQueryNormalizer
  ↓
TaskContextCandidateCollector
  ↓
evidence merge / dedupe
  ↓
TaskContextRanker
  ↓
TaskContextBudgeter
  ↓
TaskContextCompiler
  ↓
TaskContextPlan
  ↓
Phase15A context_read
```

| Unit | Responsibility |
| --- | --- |
| `TaskQueryNormalizer` | Convert task text and explicit inputs into deterministic normalized terms and anchors. |
| `TaskContextCandidateCollector` | Gather candidate subjects and evidence from available CodeAtlas capabilities. |
| `TaskContextRanker` | Assign priority, deterministic rank signals, reasons, and fused ordering. |
| `TaskContextBudgeter` | Select required, then supporting, then optional subjects under explicit limits. |
| `TaskContextCompiler` | Orchestrate the units, produce identities/reliability metadata, and return the plan. |

The compiler is a composition boundary over existing repository services. It may
resolve paths and exact symbols, but it does not become a second source of graph,
index, change, or reliability truth.

## 3. Normalization and candidate collection

### 3.1 TaskQueryNormalizer

Normalization is deterministic and preserves the original task separately from
its normalized representation. It may extract identifier-like terms, file paths,
symbol-like names, explicit anchors, changed paths, and stable deduplicated query
terms for lexical and optional semantic/hybrid retrieval.

Normalization must not claim that a token is an exact symbol without resolver
proof. Path normalization follows repository-relative `ContextSubject` rules.
Invalid task input or invalid explicit anchors is a hard error.

### 3.2 Candidate sources

The collector may use these sources, in order of authority:

1. explicit file/symbol anchors;
2. exact symbol/file resolution;
3. lexical plus optional semantic/hybrid retrieval;
4. bounded one-hop graph relationships;
5. change/impact evidence;
6. affected tests.

Each candidate carries source evidence and capability provenance. Candidates from
multiple sources are merged by canonical `ContextSubject` identity; evidence is
accumulated rather than duplicated.

Graph fan-out is capped before ranking and final budgeting. The collector must not
recursively expand graph relationships or allow a high-degree node to consume the
entire plan.

## 4. Priority and ranking

Every candidate is assigned one tier:

```ts
type TaskContextPriority = "required" | "supporting" | "optional";
```

Required candidates include explicit file/symbol anchors, uniquely resolved exact
task targets, and explicit changed targets.

Supporting candidates include direct graph neighbors of required subjects, strong
corroborated retrieval candidates, and directly affected tests.

Optional candidates include weaker lexical candidates, secondary impact
candidates, and contextual evidence from one source only.

Explicit and exact evidence always outranks fuzzy or retrieval evidence. An
ambiguous symbol may remain supporting or optional retrieval evidence, but cannot
be promoted to an exact required target.

Within a tier, use deterministic evidence fusion. Raw lexical, vector, graph, and
impact scores must not be added directly because their scales differ. An
RRF-style contribution is preferred:

```text
fusedSignal(candidate) = Σ sourceWeight(source) / (rrfConstant + sourceRank)
```

Constants and source weights are strategy configuration/version data, not runtime
model tuning. Final ties are broken by the canonical `ContextSubject` key. The
plan records a deterministic score/rank signal, not an unsupported probability.
Every selected item has at least one reason and preserves its causal evidence.

## 5. Reliability and capability degradation

The compiler inherits CodeAtlas reliability semantics:

- positive stale evidence may still be used, with a diagnostic;
- missing stale or incomplete evidence is never proof of absence;
- ambiguous resolution is never silently treated as exact;
- current capability state is reported alongside selected evidence.

If graph, index, lexical, semantic, change, impact, or affected-test capability is
stale, incomplete, unavailable, or fails, the compiler degrades using remaining
evidence, sets `reliability.mayBeIncomplete = true`, and returns bounded
diagnostics. An optional capability failure must not crash compilation.

Only invalid input, repository resolution failure, and workspace resolution
failure are hard errors. A plan with incomplete evidence is valid and must expose
that incompleteness.

## 6. TaskContextPlan contract

The public plan is approximately:

```ts
type TaskContextPlan = {
  taskIdentity: string;
  planIdentity: string;
  repositoryIdentity: string;
  workspaceIdentity: string;
  items: TaskContextItem[];
  budget: {
    maxItems: number;
    maxEstimatedTokens: number;
    selectedItems: number;
    estimatedTokens: number;
    omittedItems: number;
    budgetExceeded: boolean;
  };
  reliability: {
    mayBeIncomplete: boolean;
    capabilityStates: unknown;
    diagnostics: string[];
  };
  compiler: {
    schemaVersion: number;
    strategyVersion: string;
  };
};

type TaskContextItem = {
  subject: ContextSubject;
  priority: "required" | "supporting" | "optional";
  rank: number;
  scoreSignal: number;
  reasons: string[];
  evidence: unknown[];
  estimatedTokens?: number;
};
```

`ContextSubject` is imported from the exact Phase15A contract:

```ts
type ContextSubject =
  | { kind: "file"; path: string }
  | { kind: "symbol"; path: string; symbolId: string; selectorVersion: string };
```

Final item order is deterministic: required, supporting, then optional; within
each tier, fused rank and canonical subject key determine ordering.

## 7. Identity model

`taskIdentity` is the identity of the normalized logical task. Conceptually it
is a versioned digest such as `task-v1:<digest>`, deterministically derived
only from:

- normalized task text;
- normalized explicit anchors;
- normalized `changedPaths`;
- the versioned task-identity/normalization schema.

It must not depend on repository/index generations, capability state, compiler
runtime timing, budget, session identity, or receipt identity. It remains stable
when the same logical task is compiled against changed repository evidence.

`planIdentity` is the identity of the concrete compiled plan. It depends on
task identity, repository/workspace identity, compiler schema and strategy
versions, selected subjects/order/priorities, budget decisions, and relevant
capability state/generation.

Thus the same task may retain its `taskIdentity` while its `planIdentity` changes
as source, graph, index, change, or capability evidence changes.

```text
taskIdentity    = WHAT task
planIdentity    = WHICH context plan
sessionIdentity = WHO/WHEN consumes context
receiptIdentity = WHAT was delivered
```

The compiler must not infer `ContextSession` or `sessionIdentity` from
`taskIdentity`. Phase15A owns delivery sessions and receipts.

## 8. Budgeting and selection

Phase15B budgets subjects before delivery. It must not blindly reuse a rendered
chunk budget abstraction because the compiler selects references, not payloads.

The default request supports both:

```ts
budget?: {
  maxItems?: number;
  maxEstimatedTokens?: number;
}
```

Selection:

1. include required subjects, subject to validity rules;
2. add supporting subjects by deterministic rank;
3. add optional subjects by deterministic rank;
4. stop at `maxItems` or `maxEstimatedTokens`;
5. report omitted candidates and whether the budget was exceeded.

Required items are not silently displaced by lower-priority items. If required
items alone exceed a configured budget, return all valid required items,
`budgetExceeded: true`, and an explanatory diagnostic.

Estimated token cost uses available indexed/source-span/file metadata. The compiler
must not read or render an entire source file merely to obtain an exact count.
Unknown costs remain unknown or use a documented bounded estimate; they are not
presented as exact measurements.

## 9. MCP and CLI surfaces

The primary agent-facing MCP tool is `compile_task_context`.

Recommended input:

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

Default detail is `compact`. Compact output contains identities, selected
subjects, priorities/ranks, short reasons, reliability, and bounded metadata.
Full detail may additionally contain complete evidence, fusion information,
omitted candidates, budget decisions, and capability diagnostics.

The tool must not accept `sessionId`, `receiptId`, conversation history, model
name, or agent name. It returns references/metadata only and must not call
`context_read`.

An explicit symbol anchor with a path may resolve uniquely. A symbol anchor
without a path may remain ambiguous. Neither form may be guessed into an exact
required target; unresolved or ambiguous anchors remain non-exact evidence.

The CLI is an inspection/debug surface:

```bash
code-atlas context-compile --task "..."
code-atlas context-compile --task "..." --json
```

Human output may use existing CLI presentation conventions. JSON output is
deterministic and ANSI-free. MCP remains the primary agent interface; the CLI
does not become a second compiler implementation.

## 10. Relationship with Phase15A

```text
compile_task_context(task)
  → TaskContextPlan with selected ContextSubject references
  → Phase15A context_read for each selected subject
  → full / unchanged / delta / rehydrate delivery decision
```

Phase15B compilation correctness does not require executing delivery. Phase15A
delivery correctness does not require a `TaskContextCompiler`. Phase15B
intentionally depends on and reuses the Phase15A `ContextSubject` contract,
but does not duplicate Phase15A session, receipt, projection, or delivery
responsibilities.

## 11. Testing and acceptance criteria

Implementation is conformant only if focused tests prove:

- explicit anchors and uniquely resolved exact targets are required;
- ambiguous symbols are never guessed or promoted to required exact targets;
- candidates merge and deduplicate by canonical `ContextSubject` identity;
- one-hop graph expansion is bounded and never recursively floods the plan;
- rule-first priority and deterministic rank fusion produce stable ordering;
- required/supporting/optional selection honors both budgets;
- required overflow is explicit and does not silently drop required subjects;
- stale positive evidence is retained with warning, while missing evidence is not
  treated as proof of absence;
- optional capability failure degrades to remaining evidence with diagnostics;
- invalid input/repository/workspace resolution failures are hard errors;
- equivalent compilation produces identical plan output and identities;
- changed evidence can change `planIdentity` without changing `taskIdentity`;
- task identity changes only when normalized task inputs or the versioned
  task-identity/normalization schema changes, never because of budget,
  capability state, repository/index generation, timing, session, or receipt;
- `compile_task_context` does not call `context_read` or return source bodies;
- compact and full detail have the documented bounded difference;
- CLI JSON and MCP output are deterministic and ANSI-free;
- every Phase15B v1 emitted `ContextSubject` is accepted directly by the
  Phase15A `context_read` integration without translation or adaptation;
- the direct compatibility test covers every Phase15B v1 subject kind: file and
  symbol.

Evaluation fixtures should measure required-file and required-symbol recall,
first-useful-hit rank, irrelevant-context ratio, selected item count, estimated
tokens, omitted candidates, and downstream exploration/tool steps. Baselines
should include lexical search only and existing CodeAtlas primitives without
`compile_task_context`. Initial hard expectations are:

- explicit exact target hit: 100%;
- deterministic repeatability: 100%;
- ambiguous false-required promotion: 0%;
- required subject silently dropped by budget: 0%.

Do not introduce a Context Precision threshold at this stage. Add representative
language-neutral fixtures in TypeScript, Python, Java or Kotlin, and Go or Rust
to prove the compiler has no accidental TypeScript/JavaScript coupling. These
fixtures validate the same contracts; they do not create language-specific
compiler behavior.

## 12. Non-goals

- Phase15A context delivery, receipts, snapshots, or session persistence;
- Phase15C lifecycle adapters or harness orchestration;
- Phase15D evaluation platform;
- generic agent or conversation memory;
- repository-wide summarization or chat/RAG generation;
- mandatory semantic search, embeddings, LLMs, or external services;
- recursive graph traversal;
- automatic source rendering or context delivery;
- replacing primitive CodeAtlas search, graph, change, impact, or test APIs;
- changes to AtlasStore truth, index/storage semantics, resolver ambiguity policy, or
  reliability semantics.
