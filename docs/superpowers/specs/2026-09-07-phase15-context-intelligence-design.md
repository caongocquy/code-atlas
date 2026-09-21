# Phase 15 — Context Intelligence

**Status:** Proposed design specification

## 1. Goal

Extend CodeAtlas from repository/change intelligence into context intelligence for coding agents without turning CodeAtlas into a memory system, agent runtime, or generic RAG stack.

The feature set must reduce two independent sources of context waste:

1. **Breadth waste** — the agent reads code that is not needed for the current task.
2. **Repetition waste** — the agent receives code it has already seen in the current reliable context.

Canonical thesis:

> CodeAtlas gives coding agents the minimum relevant code, then avoids sending the same code twice.

## 2. Product boundary

Context Intelligence is a consumer of existing CodeAtlas intelligence.

```text
ParsedFacts
  -> Resolver
  -> ResolvedGraph
  -> Change Intelligence
  -> Coverage / Uncertainty
  -> Context Intelligence
       |- Relevance: what should the agent read?
       `- Delivery: what does the agent need to receive again?
```

Context Intelligence must not redefine graph semantics, resolver semantics, change intelligence semantics, or index persistence.

## 3. Release strategy

The entire Phase 15 stack is developed and dogfooded privately, then released as one public capability set.

Internal phases:

- **15A Context-Aware Reads** — reduce repetition.
- **15B Task Context** — reduce breadth.
- **15C Harness Lifecycle Integration** — make visibility receipts trustworthy where harness lifecycle signals exist.
- **15D Context Evals** — prove value and safety.

No individual Phase 15 subfeature is required to be public before the complete Context Intelligence release is ready.

## 4. Compatibility strategy

Incremental read behavior is **opt-in at protocol/capability level**.

Default behavior remains backward-compatible:

```text
read_symbol / read_range / read_file
-> full content
```

A client/harness that advertises support may receive:

```text
full | unchanged | delta | rehydrate
```

Official CodeAtlas integrations may opt in automatically once their adapters support the protocol. Unknown/legacy clients continue to receive full reads.

## 5. Core invariants

1. Repository state and model-visible context state are different things.
2. `file unchanged` never implies `model still knows file`.
3. `unchanged` is allowed only when CodeAtlas has reliable evidence that the previously delivered content remains visible in the current context generation.
4. If visibility is uncertain, prefer `rehydrate` over `unchanged`.
5. Deltas are computed against the **exact content snapshot previously delivered**, not Git HEAD or another repository baseline.
6. Context receipt state is ephemeral/session-scoped and is not mixed into graph/index persistence.
7. Worktree/source identity must prevent accidental deduplication across distinct source workspaces.
8. Context Intelligence composes evidence; it does not fabricate repository facts.
9. Existing primitive tools remain available as escape hatches.
10. Correctness is more important than token savings.

## 6. Architecture

```text
                         +-----------------------+
Task -----------------> | Task Context Engine   |
                         |  seeds / expand / rank|
                         |  budget pack          |
                         +-----------+-----------+
                                     |
                                     v
                         +-----------------------+
                         | Retrieval primitives  |
                         | symbol/range/file      |
                         +-----------+-----------+
                                     |
                                     v
                         +-----------------------+
                         | Context-Aware Reader  |
                         | identity / receipts   |
                         | snapshots / delta     |
                         | hydration             |
                         +-----------+-----------+
                                     |
                                     v
                    full | unchanged | delta | rehydrate
```

Supporting lifecycle adapter:

```text
Harness session/reset/compaction signals
          -> Context Generation Manager
          -> receipt visibility validity
```

## 7. Non-goals

Phase 15 does not make CodeAtlas a:

- general memory system
- chat history store
- terminal-output compressor
- test-log compressor
- LLM summarizer
- agent runtime
- planner LLM
- arbitrary MCP-output cache
- persistent cross-session semantic memory

## 8. Public-facing capability shape

Potential high-level tools:

```text
context(task, budget?)
read_symbol(...)
read_range(...)
read_file(...)
context_status(...)
context_reset(...)
context_invalidate(...)
```

The existing read tools remain the normal entry point. Context management primitives are secondary and should not burden normal agent workflows.

## 9. Success criteria

The feature set is ready for public release only when evals show all of the following:

- relevant-code recall is not materially worse than current exploration baselines
- repeated-context delivery is significantly reduced on multi-step coding tasks
- total injected context decreases
- exploration tool calls decrease or remain neutral
- no stale-context correctness regressions
- no cross-worktree receipt collisions
- backward-compatible clients continue to work without opt-in
- Phase 13/14 repository/change intelligence behavior does not regress

## 10. Release positioning

Recommended public framing:

> **CodeAtlas Context Intelligence**
>
> Find less. Send less.
>
> CodeAtlas narrows the working set for a coding task, then incrementally delivers only the code the agent still needs.

