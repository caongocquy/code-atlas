import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { executeLifecycleScenario } from "../eval/context/runner/execute-case.js";
import { scoreLifecycle } from "../eval/context/runner/score-case.js";
import type { EvalCase } from "../eval/context/types.js";
import type { TaskContextPlanDetail } from "../src/core/context/task-context.types.js";

function plan(): TaskContextPlanDetail {
  return {
    taskIdentity: "task-lifecycle",
    planIdentity: "plan-lifecycle",
    repositoryIdentity: "repo-lifecycle",
    workspaceIdentity: "workspace-lifecycle",
    items: [{ subject: { kind: "file", path: "source.ts" }, priority: "required", rank: 1, reasons: ["test"] }],
    budget: { maxItems: 10, maxEstimatedTokens: 100, selectedItems: 1, estimatedTokens: 1, omittedItems: 0, budgetExceeded: false },
    reliability: { mayBeIncomplete: false, capabilityStates: {}, diagnostics: [] },
    capabilityFingerprint: "none",
    compiler: { schemaVersion: 1, strategyVersion: "task-context-v1" },
    projection: { detail: "compact", detailsAvailable: false, omitted: 0, truncated: false },
  };
}

function lifecycleCase(): EvalCase {
  return {
    caseId: "lifecycle-case",
    kind: "synthetic",
    language: "typescript",
    syntheticClass: "exact-target",
    workspaceRef: "fixture",
    task: "read source",
    anchors: [],
    changedPaths: [],
    lifecycle: {
      primitives: [
        { kind: "start" },
        { kind: "refresh", expectedModeSequence: ["unchanged"] },
        { kind: "mutate", files: { "source.ts": "one\ntwo\n" } },
        { kind: "refresh", expectedModeSequence: ["delta"] },
        { kind: "restart" },
        { kind: "refresh", expectedModeSequence: ["unchanged"] },
      ],
      expectedModes: ["full", "unchanged", "delta", "unchanged"],
    },
    truth: { requiredSubjects: [], supportingSubjects: [], forbiddenRequiredSubjects: [] },
  };
}

test("executes lifecycle delivery, restart, workspace, and CAS evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-context-eval-lifecycle-"));
  try {
    await writeFile(path.join(root, "source.ts"), "one\n");
    const observed = await executeLifecycleScenario({ evalCase: lifecycleCase(), root }, {
      lifecycleDeps: {
        repositoryPath: root,
        now: () => new Date("2026-09-19T00:00:00.000Z"),
        readCurrentChangedPaths: async () => [],
        compileTaskContextForRepository: async () => plan(),
      },
    });

    assert.deepEqual(observed.modes, ["full", "unchanged", "delta", "unchanged"]);
    assert.equal(observed.bodyResendCount, 1);
    assert.deepEqual(observed.sessionIds, [observed.sessionIds[0], observed.sessionIds[0], observed.sessionIds[0], observed.sessionIds[0]]);
    assert.deepEqual(observed.contextGenerations, [observed.contextGenerations[0], observed.contextGenerations[0], observed.contextGenerations[0], observed.contextGenerations[0]]);
    assert.equal(observed.reconstructedContents["file:source.ts"], "one\ntwo\n");
    assert.equal(observed.crossWorkspaceRefused, true);
    assert.equal(observed.restartContinuity, true);
    assert.equal(observed.casLoserWroteNoStrayState, true);
    assert.deepEqual(scoreLifecycle(observed, lifecycleCase().lifecycle!), []);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("lifecycle scorer rejects unstable identity and missing race evidence", () => {
  const value = {
    modes: ["full"], fullItems: 1, deltaItems: 0, unchangedItems: 0, rehydratedItems: 0,
    requestedBytes: 1, returnedBytes: 1, savedBytes: 0, reuseRate: 0, bodyResendCount: 1,
    sessionIds: ["a", "b"], contextGenerations: ["g"], crossWorkspaceRefused: false,
    restartContinuity: false, casLoserWroteNoStrayState: false, reconstructedContents: { "file:a": "x" },
  } as const;
  const failures = scoreLifecycle(value, { primitives: [{ kind: "start" }, { kind: "restart" }], expectedModes: ["full"] });
  assert.deepEqual(failures.map((failure) => failure.gate), [
    "lifecycle.session_stability",
    "lifecycle.cross_workspace_refused",
    "lifecycle.restart_continuity",
    "lifecycle.cas_loser_state",
  ]);
});

test("lifecycle scorer rejects corrupted reconstructed content", () => {
  const observed = {
    modes: ["full", "delta", "unchanged"], fullItems: 1, deltaItems: 1, unchangedItems: 1, rehydratedItems: 0,
    requestedBytes: 3, returnedBytes: 3, savedBytes: 0, reuseRate: 0, bodyResendCount: 1,
    sessionIds: ["session"], contextGenerations: ["generation"], crossWorkspaceRefused: true,
    restartContinuity: true, casLoserWroteNoStrayState: true, reconstructedContents: { "file:source.ts": "corrupted" },
  } as const;
  const failures = scoreLifecycle(observed, lifecycleCase().lifecycle!);
  assert.ok(failures.some((failure) => failure.gate === "lifecycle.reconstruction"));
});

test("lifecycle scorer rejects an absent expected mutated reconstruction key", () => {
  const observed = {
    modes: ["full", "delta", "unchanged"], fullItems: 1, deltaItems: 1, unchangedItems: 1, rehydratedItems: 0,
    requestedBytes: 3, returnedBytes: 3, savedBytes: 0, reuseRate: 0, bodyResendCount: 1,
    sessionIds: ["session"], contextGenerations: ["generation"], crossWorkspaceRefused: true,
    restartContinuity: true, casLoserWroteNoStrayState: true, reconstructedContents: { "file:other.ts": "one\ntwo\n" },
  } as const;
  const failures = scoreLifecycle(observed, lifecycleCase().lifecycle!);
  assert.ok(failures.some((failure) => failure.gate === "lifecycle.reconstruction"));
});

test("lifecycle scorer rejects an inconsistent body resend count", () => {
  const observed = {
    modes: ["full", "unchanged"], fullItems: 1, deltaItems: 0, unchangedItems: 1, rehydratedItems: 0,
    requestedBytes: 2, returnedBytes: 1, savedBytes: 1, reuseRate: 0.5, bodyResendCount: 0,
    sessionIds: ["session"], contextGenerations: ["generation"], crossWorkspaceRefused: true,
    restartContinuity: true, casLoserWroteNoStrayState: true, reconstructedContents: { "file:source.ts": "one\n" },
  } as const;
  const failures = scoreLifecycle(observed, { primitives: [{ kind: "start" }], expectedModes: ["full", "unchanged"] });
  assert.ok(failures.some((failure) => failure.gate === "lifecycle.body_resend_count"));
});

test("lifecycle scorer rejects wrong per-refresh order with the same aggregate mode set", () => {
  const observed = {
    modes: ["full", "delta", "unchanged", "unchanged"], fullItems: 1, deltaItems: 1, unchangedItems: 2, rehydratedItems: 0,
    requestedBytes: 4, returnedBytes: 2, savedBytes: 2, reuseRate: 0.5, bodyResendCount: 1,
    sessionIds: ["session"], contextGenerations: ["generation"], crossWorkspaceRefused: true,
    restartContinuity: true, casLoserWroteNoStrayState: true, reconstructedContents: { "file:source.ts": "one\ntwo\n" },
  } as const;
  const failures = scoreLifecycle(observed, lifecycleCase().lifecycle!);
  assert.ok(failures.some((failure) => failure.gate === "lifecycle.mode_sequence.refresh"));
});
