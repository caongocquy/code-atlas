# Phase 15B — Task Context

**Status:** Proposed design specification

## 1. Goal

Given a coding task, return a bounded, explainable working set of repository context that is sufficient to start productive investigation while preserving access to lower-level CodeAtlas primitives.

Canonical interface:

```text
context(task, budget?)
```

This feature reduces **breadth waste**. It does not replace symbol search, callers/callees, trace, impact, affected tests, or other primitives.

## 2. Core rule

Task Context is an intelligence composition layer, not a new source of repository truth.

It may consume:

- lexical/symbol search
- graph relations
- imports/dependencies
- change intelligence
- affected tests
- public/contract evidence
- coverage/incompleteness diagnostics

It must not invent unsupported relations.

## 3. Pipeline

```text
task text
  -> task normalization
  -> seed discovery
  -> bounded structural expansion
  -> evidence aggregation
  -> relevance scoring
  -> diversity / redundancy control
  -> token-budget packing
  -> explainable working set
```

## 4. Seed discovery

V1 should avoid mandatory LLM planning.

Seed discovery should use deterministic/cheap signals first:

- lexical token extraction from task
- identifier-like terms
- symbol/file/module search
- existing repository lexical index
- optional semantic provider only if already configured and explicitly available

No new mandatory model/runtime/service is introduced.

## 5. Expansion

Expansion is bounded and relation-aware.

Candidate relations may include:

- direct callers
- direct callees
- import owners/imported modules
- containment/owner symbols
- affected symbols
- likely affected tests
- public contract/type surfaces

Expansion must have explicit limits such as:

```text
maxDepth
maxSymbols
maxFiles
maxTests
maxCandidates
```

Do not recursively flood the entire graph.

## 6. Relevance model

Scoring must remain explainable.

Conceptual evidence contributions:

```text
seed lexical/symbol match
+ direct graph relation
+ change/impact relation
+ test relation
+ same-module proximity
+ contract/public-surface relevance
- ambiguity penalty
- incomplete/weak evidence penalty
- redundancy penalty
```

Exact weights are implementation/eval concerns, not public API guarantees.

Every selected item should include one or more reasons.

## 7. Budget packing

Task Context is not useful if it returns an unbounded repository dump.

Input may specify a context budget:

```ts
context({ task, tokenBudget: 8000 })
```

Packing should favor:

1. direct task targets
2. structurally necessary neighbors
3. relevant tests/contracts
4. diversity across evidence roles

Avoid spending the entire budget on many near-duplicate symbols from one file/module.

## 8. Result shape

Conceptual result:

```ts
export type TaskContextResult = {
  task: string;
  coverage: {
    mayBeIncomplete: boolean;
    diagnostics: string[];
  };
  items: Array<{
    kind: "symbol" | "file" | "test" | "contract";
    identity: string;
    path: string;
    relevance: number;
    reasons: string[];
    evidence: string[];
    estimatedTokens: number;
  }>;
  budget: {
    requestedTokens?: number;
    packedTokens: number;
  };
  suggestedNextActions?: string[];
};
```

V1 may return references/metadata rather than eagerly injecting all source bodies. Context-Aware Reads can deliver selected source incrementally.

## 9. Interaction with Context-Aware Reads

The preferred composition is:

```text
context(task)
-> selects working set
-> agent reads selected items
-> Context-Aware Reads chooses full/delta/unchanged/rehydrate
```

Task Context answers **what to read**.

Context-Aware Reads answers **what must be sent again**.

Neither subsystem should depend on the other for correctness.

## 10. Uncertainty

Existing CodeAtlas uncertainty semantics remain authoritative.

If graph/index evidence is incomplete:

- do not claim negative evidence as authoritative
- expose `mayBeIncomplete`
- include missing/weak evidence diagnostics
- avoid confidence language unsupported by the underlying engine

Task Context may still return known-positive evidence under incomplete coverage.

## 11. Escape hatches

Primitive tools remain first-class:

```text
search
callers
callees
trace
impact
affected_tests
read_symbol
read_range
```

`context(task)` is a recommended starting point, not the only exploration path.

## 12. Non-goals

- replacing agent reasoning
- mandatory LLM planning inside CodeAtlas
- summarizing the entire repository
- generic RAG/chat memory
- hiding primitive graph/change APIs
- returning every potentially related file

## 13. Evals

Required task-context metrics:

```text
required-file recall@K
required-symbol recall@K
MRR / first-useful-hit rank
irrelevant-context ratio
packed tokens
exploration tool calls
wrong-file edit rate (if measurable)
time/tool-steps to first relevant edit (optional)
```

Baselines should include:

- `rg`/lexical search only
- existing CodeAtlas primitives without `context(task)`
- optional semantic-only retrieval when available

## 14. Acceptance criteria

1. Known task fixtures recover required files/symbols with strong recall under bounded budgets.
2. Context size is materially smaller than broad search/read baselines.
3. Every included item has explainable evidence.
4. Incompleteness is surfaced rather than hidden.
5. Agent may continue with primitives when the returned working set is insufficient.
6. No mandatory LLM/service is added.
7. Existing graph/change semantics remain unchanged.
8. Combined with Context-Aware Reads, total exploration context cost is lower on multi-step coding tasks.

