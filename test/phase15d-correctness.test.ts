import assert from "node:assert/strict";
import test from "node:test";

import { scoreCase } from "../eval/context/runner/score-case.js";
import type { EvalCase, ObservedCase } from "../eval/context/types.js";
import { contentIdentity } from "../src/core/context/context-snapshot.js";

const main = { kind: "symbol" as const, path: "src/main.ts", symbolId: "symbol:main", selectorVersion: "1" };
const helper = { kind: "file" as const, path: "src/helper.ts" };
const fallback = { kind: "file" as const, path: "src/fallback.ts" };
const forbidden = { kind: "file" as const, path: "src/forbidden.ts" };

function evalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    caseId: "incomplete-context",
    kind: "synthetic",
    language: "typescript",
    syntheticClass: "incomplete/ambiguity",
    workspaceRef: "synthetic/typescript/incomplete-context",
    task: "trace ambiguous context",
    anchors: [{ kind: "symbol", path: "src/main.ts", name: "main" }],
    changedPaths: [],
    truth: {
      requiredSubjects: [main],
      supportingSubjects: [helper, fallback],
      forbiddenRequiredSubjects: [forbidden],
    },
    ...overrides,
  };
}

function observed(overrides: Partial<ObservedCase> = {}): ObservedCase {
  const contents = {
    main: "export function main() {}\n",
    helper: "export const helper = true;\n",
    fallback: "export const fallback = true;\n",
  };
  return {
    caseId: "incomplete-context",
    repositoryIdentity: "repository-identity",
    workspaceIdentity: "workspace-identity",
    taskIdentity: "task-identity",
    planIdentity: "plan-identity",
    selectedItems: [
      { subject: main, priority: "required", rank: 1, reasons: ["anchor"] },
      { subject: helper, priority: "supporting", rank: 2, reasons: ["related"] },
      { subject: fallback, priority: "supporting", rank: 3, reasons: ["fallback"] },
    ],
    reliability: { mayBeIncomplete: true, capabilityStates: { graph: "stale" }, diagnostics: ["graph is stale"] },
    deliveries: [
      { subject: main, receiptId: "main", reliability: { mayBeIncomplete: true }, mode: "full", current: { contentIdentity: contentIdentity(contents.main), reliability: { mayBeIncomplete: true } }, content: contents.main },
      { subject: helper, receiptId: "helper", reliability: { mayBeIncomplete: true }, mode: "delta", current: { contentIdentity: contentIdentity(contents.helper), reliability: { mayBeIncomplete: true } }, delta: { kind: "replace", content: contents.helper, contentIdentity: contentIdentity(contents.helper) } },
      { subject: fallback, receiptId: "fallback", reliability: { mayBeIncomplete: true }, mode: "rehydrate", current: { contentIdentity: contentIdentity(contents.fallback), reliability: { mayBeIncomplete: true } }, content: contents.fallback, reason: "missing_receipt" },
    ],
    reconstructedContents: { arbitraryMainKey: contents.main, arbitraryHelperKey: contents.helper, arbitraryFallbackKey: contents.fallback },
    lifecycleModes: ["full", "delta", "rehydrate"],
    metrics: {
      selectedItems: 3,
      estimatedTokens: 30,
      returnedBytes: 70,
      requiredHitRate: 0,
      supportingHitRate: 0,
      contextPrecision: 1,
      fullItems: 1,
      deltaItems: 1,
      unchangedItems: 0,
      rehydratedItems: 1,
      requestedBytes: 90,
      savedBytes: 20,
      reuseRate: 2 / 9,
      bodyResendCount: 2,
      timingsMs: { indexLoad: 1, compile: 2, lifecycleStart: 0, refresh: 0 },
    },
    ...overrides,
  };
}

test("scores canonical truth, full/delta/rehydrate reconstruction, and preserved incomplete diagnostics", () => {
  const score = scoreCase({ evalCase: evalCase(), first: observed(), repeat: observed() });

  assert.equal(score.metrics.requiredHitRate, 1);
  assert.equal(score.metrics.supportingHitRate, 1);
  assert.deepEqual(score.failures, []);
  assert.deepEqual(score.gates, {
    correctness: true,
    determinism: true,
    reconstruction: true,
    authorityUncertainty: true,
    isolation: true,
    catastrophicQuality: true,
  });
});

test("reports each available subject, authority, uncertainty, reconstruction, and semantic regression", () => {
  const first = observed({
    selectedItems: [
      { subject: { kind: "file", path: "src/main.ts" }, priority: "required", rank: 1, reasons: ["wrong-kind"] },
      { subject: forbidden, priority: "required", rank: 2, reasons: ["forbidden"] },
    ],
    reliability: { mayBeIncomplete: false, capabilityStates: { graph: "ready" }, diagnostics: [] },
    deliveries: [{ subject: main, receiptId: "main", reliability: {}, mode: "full", current: { contentIdentity: contentIdentity("authoritative\n"), reliability: {} }, content: "different\n" }],
    reconstructedContents: { only: "wrong\n" },
  });
  const repeat = observed({
    taskIdentity: "different-task-intent",
    planIdentity: "different-plan",
    selectedItems: [{ subject: main, priority: "supporting", rank: 2, reasons: ["changed"] }],
    reliability: { mayBeIncomplete: true, capabilityStates: { graph: "stale" }, diagnostics: ["graph is stale"] },
    metrics: { ...observed().metrics, returnedBytes: 71 },
  });

  const score = scoreCase({ evalCase: evalCase(), first, repeat });
  const gates = score.failures.map((failure) => failure.gate);

  assert.equal(score.metrics.requiredHitRate, 0);
  assert.equal(score.metrics.supportingHitRate, 0);
  assert.deepEqual(gates, [
    "correctness.required_hit_rate",
    "authority.false_required",
    "authority.forbidden_required",
    "uncertainty.incomplete_preserved",
    "uncertainty.diagnostics",
    "reconstruction.content_identity",
    "reconstruction.authoritative_text",
    "determinism.task_identity",
    "determinism.plan_identity",
    "determinism.selected_items",
    "determinism.reliability",
    "determinism.deliveries",
    "determinism.reconstructed_contents",
    "determinism.metrics",
  ]);
  assert.equal(score.gates.correctness, false);
  assert.equal(score.gates.determinism, false);
  assert.equal(score.gates.reconstruction, false);
  assert.equal(score.gates.authorityUncertainty, false);
  assert.equal(score.gates.isolation, true);
  assert.equal(score.gates.catastrophicQuality, true);
});

test("does not accept a required truth subject when it is demoted to supporting", () => {
  const first = observed({
    selectedItems: [
      { subject: main, priority: "supporting", rank: 1, reasons: ["demoted"] },
      { subject: helper, priority: "supporting", rank: 2, reasons: ["related"] },
      { subject: fallback, priority: "supporting", rank: 3, reasons: ["fallback"] },
    ],
  });
  const score = scoreCase({ evalCase: evalCase({ syntheticClass: "exact-target" }), first, repeat: first });

  assert.deepEqual(score.failures.map((failure) => failure.gate), ["authority.required_priority"]);
  assert.equal(score.metrics.requiredHitRate, 1);
  assert.equal(score.gates.authorityUncertainty, false);
});

test("fails reconstruction when a selected delivery returns an error", () => {
  const first = observed({
    deliveries: [{ subject: main, mode: "error", error: { code: "subject_unavailable", message: "missing source" } }],
  });
  const score = scoreCase({ evalCase: evalCase({ syntheticClass: "exact-target" }), first, repeat: first });

  assert.deepEqual(score.failures.map((failure) => failure.gate), ["reconstruction.delivery_error"]);
  assert.equal(score.gates.reconstruction, false);
});
