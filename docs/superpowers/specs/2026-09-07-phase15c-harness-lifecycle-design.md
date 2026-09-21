# Phase 15C — Harness Lifecycle Integration

**Status:** Proposed design specification

## 1. Goal

Make Context-Aware Reads safe and useful across supported coding-agent harnesses by translating available harness lifecycle events into CodeAtlas context session/generation state.

## 2. Core invariant

Harness lifecycle evidence may increase receipt reliability, but lack of evidence must never be interpreted as proof that model-visible context still exists.

Unknown visibility -> `rehydrate`.

## 3. Adapter contract

Conceptual lifecycle events:

```ts
export type HarnessContextEvent =
  | { kind: "session_started"; sessionId: string }
  | { kind: "context_generation_changed"; sessionId: string; generationId: string }
  | { kind: "context_compacted"; sessionId: string; generationId?: string }
  | { kind: "context_reset"; sessionId: string }
  | { kind: "session_ended"; sessionId: string };
```

Adapters may expose only the subset their harness can prove.

## 4. Reliability modes

```text
trusted
  lifecycle signals sufficient to prove generation continuity

explicit
  client explicitly calls reset/generation APIs

best_effort
  insufficient lifecycle signals; conservative rehydration required
```

## 5. Supported integrations

Each official CodeAtlas integration should document:

- how session ID is derived
- whether compaction/reset is observable
- whether context generation is observable
- what capability advertisement is sent
- fallback behavior when lifecycle hooks are unavailable

Do not fabricate lifecycle hooks that the harness does not provide.

## 6. Capability negotiation

Official adapters may advertise:

```json
{
  "contextAwareReads": true,
  "contextLifecycle": "trusted"
}
```

Legacy/unknown clients remain full-read by default.

## 7. Non-goals

- storing chat transcripts
- reconstructing hidden model context
- intercepting arbitrary harness output
- claiming compaction visibility when no supported signal exists

## 8. Acceptance criteria

1. Session reset invalidates receipts.
2. Compaction/generation changes invalidate or advance visibility correctly.
3. Harness without reliable lifecycle signal never gets unsafe unchanged responses.
4. Existing integrations continue working when capability is disabled.
5. Adapter behavior is covered by deterministic lifecycle tests.

