import assert from "node:assert/strict";
import test from "node:test";

import { compareSemanticObserved, normalizeObserved } from "../eval/context/runner/normalize-result.js";
import { rankTaskContextCandidates } from "../src/core/context/task-context-ranker.js";
import type { TaskContextCandidate } from "../src/core/context/task-context.types.js";
import type { ObservedCase } from "../eval/context/types.js";

function observed(overrides: Partial<ObservedCase> = {}): ObservedCase {
  return {
    caseId: "determinism-case",
    repositoryIdentity: "path-v1:repository-a",
    workspaceIdentity: "filesystem-v1:/private/tmp/code-atlas-context-eval-first",
    taskIdentity: "task-identity",
    planIdentity: "plan-identity-a",
    selectedItems: [{ subject: { kind: "file", path: "src/target.ts" }, priority: "required", rank: 1, reasons: ["anchor"], estimatedTokens: 12 }],
    reliability: { mayBeIncomplete: true, capabilityStates: { graph: "stale" }, diagnostics: ["workspace /private/tmp/code-atlas-context-eval-first/src/target.ts"] },
    deliveries: [{ subject: { kind: "file", path: "src/target.ts" }, receiptId: "ephemeral-receipt", reliability: { mayBeIncomplete: true }, mode: "full", current: { contentIdentity: "content-hash", reliability: { mayBeIncomplete: true } }, content: "authoritative\n" }],
    reconstructedContents: { "/private/tmp/code-atlas-context-eval-first/src/target.ts": "authoritative\n" },
    lifecycleModes: ["full"],
    metrics: {
      selectedItems: 1,
      estimatedTokens: 12,
      returnedBytes: 14,
      requiredHitRate: 1,
      supportingHitRate: 0,
      contextPrecision: 1,
      fullItems: 1,
      deltaItems: 0,
      unchangedItems: 0,
      rehydratedItems: 0,
      requestedBytes: 14,
      savedBytes: 0,
      reuseRate: 0,
      bodyResendCount: 1,
      timingsMs: { indexLoad: 10, compile: 20, lifecycleStart: 30, refresh: 40 },
    },
    ...overrides,
  };
}

test("semantic normalization preserves raw identities and hashes, normalizes only temporary roots, and ignores timing", () => {
  const first = normalizeObserved(observed());
  const second = normalizeObserved(observed({
    repositoryIdentity: "path-v1:repository-b",
    workspaceIdentity: "filesystem-v1:/private/tmp/code-atlas-context-eval-second",
    planIdentity: "plan-identity-b",
    reliability: { mayBeIncomplete: true, capabilityStates: { graph: "stale" }, diagnostics: ["workspace /private/tmp/code-atlas-context-eval-second/src/target.ts"] },
    reconstructedContents: { "/private/tmp/code-atlas-context-eval-second/src/target.ts": "authoritative\n" },
    metrics: { ...observed().metrics, timingsMs: { indexLoad: 1, compile: 2, lifecycleStart: 3, refresh: 4 } },
  }));

  assert.equal(first.repositoryIdentity, "path-v1:repository-a");
  assert.equal(first.workspaceIdentity, "filesystem-v1:/private/tmp/code-atlas-context-eval-first");
  assert.equal(first.planIdentity, "plan-identity-a");
  const { timingsMs: _timingsMs, ...metrics } = observed().metrics;
  assert.deepEqual(first.metrics, metrics);
  assert.equal(Object.keys(first.reconstructedContents)[0]?.includes("code-atlas-context-eval-first"), false);
  assert.deepEqual(compareSemanticObserved(first, second, false), []);
});

test("semantic comparison requires identical plan identities only for identical identity inputs and detects each semantic regression", () => {
  const base = normalizeObserved(observed());
  const planMismatch = normalizeObserved(observed({ planIdentity: "plan-identity-b" }));
  const changed = normalizeObserved(observed({
    taskIdentity: "different-task",
    selectedItems: [{ subject: { kind: "file", path: "src/target.ts" }, priority: "supporting", rank: 2, reasons: ["related"], estimatedTokens: 12 }],
    reliability: { mayBeIncomplete: false, capabilityStates: { graph: "ready" }, diagnostics: [] },
    deliveries: [{ subject: { kind: "file", path: "src/target.ts" }, receiptId: "other-receipt", reliability: { mayBeIncomplete: false }, mode: "unchanged", current: { contentIdentity: "other-content", reliability: { mayBeIncomplete: false } } }],
    reconstructedContents: { "file:src/target.ts": "different\n" },
    lifecycleModes: ["unchanged"],
    metrics: { ...observed().metrics, returnedBytes: 0, timingsMs: observed().metrics.timingsMs },
  }));

  assert.deepEqual(compareSemanticObserved(base, planMismatch, false), []);
  assert.deepEqual(compareSemanticObserved(base, planMismatch, true).map((failure) => failure.gate), ["determinism.plan_identity"]);
  assert.deepEqual(compareSemanticObserved(base, changed, true).map((failure) => failure.gate), [
    "determinism.task_identity",
    "determinism.selected_items",
    "determinism.reliability",
    "determinism.deliveries",
    "determinism.reconstructed_contents",
    "determinism.lifecycle_modes",
    "determinism.metrics",
  ]);
});

test("semantic comparison ignores repository-bound symbol ids but preserves symbol ordering", () => {
  const symbol = (symbolId: string, contentIdentity: string, rank: number) => ({
    subject: { kind: "symbol" as const, path: "src/target.ts", symbolId, selectorVersion: "1" },
    priority: "supporting" as const,
    rank,
    reasons: ["change"],
    estimatedTokens: 12,
    contentIdentity,
  });
  const first = observed({
    selectedItems: [symbol("repo-a-symbol", "content-a", 1)],
    deliveries: [{ subject: symbol("repo-a-symbol", "content-a", 1).subject, receiptId: "receipt-a", reliability: { mayBeIncomplete: false }, mode: "full", current: { contentIdentity: "content-a", reliability: { mayBeIncomplete: false } }, content: "same\n" }],
  });
  const second = observed({
    repositoryIdentity: "path-v1:repository-b",
    workspaceIdentity: "filesystem-v1:/private/tmp/code-atlas-context-eval-second",
    selectedItems: [symbol("repo-b-symbol", "content-a", 1)],
    deliveries: [{ subject: symbol("repo-b-symbol", "content-a", 1).subject, receiptId: "receipt-b", reliability: { mayBeIncomplete: false }, mode: "full", current: { contentIdentity: "content-a", reliability: { mayBeIncomplete: false } }, content: "same\n" }],
  });
  assert.deepEqual(compareSemanticObserved(normalizeObserved(first), normalizeObserved(second), false), []);
  const reordered = { ...second, selectedItems: [symbol("repo-b-symbol", "content-b", 2)] };
  assert.deepEqual(compareSemanticObserved(normalizeObserved(first), normalizeObserved(reordered), false).map(({ gate }) => gate), ["determinism.selected_items"]);
});

test("ranking uses stable code identity as the symbol tie-break", () => {
  const make = (symbolId: string, semanticKey: string): TaskContextCandidate & { semanticKey: string } => ({
    subject: { kind: "symbol", path: "src/target.ts", symbolId, selectorVersion: "1" },
    evidence: [{ kind: "change", relation: "changed", path: "src/target.ts" }],
    sourceRanks: { change: 1 },
    exact: true,
    semanticKey,
  });
  const first = rankTaskContextCandidates([make("repo-a-z", "src/target.ts\0function\0alpha"), make("repo-a-a", "src/target.ts\0function\0beta")]);
  const second = rankTaskContextCandidates([make("repo-b-z", "src/target.ts\0function\0alpha"), make("repo-b-a", "src/target.ts\0function\0beta")]);
  assert.deepEqual(first.map(({ subject }) => subject.kind === "symbol" ? subject.symbolId : "file"), ["repo-a-z", "repo-a-a"]);
  assert.deepEqual(second.map(({ subject }) => subject.kind === "symbol" ? subject.symbolId : "file"), ["repo-b-z", "repo-b-a"]);
});
