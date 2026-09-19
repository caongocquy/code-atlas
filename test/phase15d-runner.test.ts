import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runContextEval, type EvalRunnerDeps } from "../eval/context/run.js";
import type { EvalCase, ObservedCase } from "../eval/context/types.js";
import type { LoadedCorpus } from "../eval/context/corpus/load-corpus.js";

function evalCase(caseId: string): EvalCase {
  return {
    caseId,
    kind: "synthetic",
    language: "typescript",
    syntheticClass: "exact-target",
    workspaceRef: `synthetic/${caseId}`,
    task: "read the target",
    anchors: [],
    changedPaths: [],
    truth: { requiredSubjects: [], supportingSubjects: [], forbiddenRequiredSubjects: [] },
  };
}

function observed(caseId: string): ObservedCase {
  return {
    caseId,
    repositoryIdentity: "repo",
    workspaceIdentity: "workspace",
    taskIdentity: `task:${caseId}`,
    planIdentity: `plan:${caseId}`,
    selectedItems: [],
    reliability: { mayBeIncomplete: false, capabilityStates: {}, diagnostics: [] },
    deliveries: [],
    reconstructedContents: {},
    lifecycleModes: [],
    metrics: {
      selectedItems: 0,
      estimatedTokens: 1,
      returnedBytes: 2,
      requiredHitRate: 1,
      supportingHitRate: 1,
      contextPrecision: 1,
      fullItems: 0,
      deltaItems: 0,
      unchangedItems: 0,
      rehydratedItems: 0,
      requestedBytes: 0,
      savedBytes: 0,
      reuseRate: 0,
      bodyResendCount: 0,
      timingsMs: { indexLoad: 100, compile: 100, lifecycleStart: 0, refresh: 0 },
    },
  };
}

function corpus(cases: readonly EvalCase[], cwd: string): LoadedCorpus {
  return {
    manifestPath: path.join(cwd, "manifest.json"),
    baselinePath: path.join(cwd, "baseline.json"),
    policyPath: path.join(cwd, "policy.json"),
    manifest: { corpusVersion: "context-eval-v1", cases, snapshots: [] },
    baseline: {
      corpusVersion: "context-eval-v1",
      baselineVersion: "context-eval-baseline-v1",
      policyVersion: "context-eval-policy-v1",
      entries: cases.map(({ caseId }) => ({ caseId, selectedItems: 0, estimatedTokens: 1, returnedBytes: 2, requiredHitRate: 1, supportingHitRate: 1 })),
    },
    policy: {
      policyVersion: "context-eval-policy-v1",
      aggregate: { maxEstimatedTokensIncreasePct: 10, maxReturnedBytesIncreasePct: 10, maxSelectedItemsIncreasePct: 10, maxRequiredHitRateDecreasePp: 0, maxSupportingHitRateDecreasePp: 5 },
      catastrophic: { maxEstimatedTokensMultiplier: 2, maxReturnedBytesMultiplier: 2, selectedItemsFormula: "baselineSelectedItems + max(3, baselineSelectedItems)", requiredTargetsMayDisappear: false },
    },
    manifestSha256: "manifest",
    baselineSha256: "baseline",
    policySha256: "policy",
  };
}

test("exports the normal context evaluator entrypoint", () => {
  assert.equal(typeof runContextEval, "function");
});

test("runs every case twice from clean executor calls and writes only the report", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "phase15d-runner-"));
  try {
    const cases = [evalCase("one"), evalCase("two")];
    const loaded = corpus(cases, cwd);
    await writeFile(loaded.baselinePath, "old baseline\n");
    await writeFile(loaded.policyPath, "old policy\n");
    let calls = 0;
    const deps: EvalRunnerDeps = {
      loadCorpus: async () => loaded,
      executeCase: async ({ evalCase: value }) => {
        calls += 1;
        return observed(value.caseId);
      },
    };

    const baselineBefore = await readFile(loaded.baselinePath);
    const result = await runContextEval({ cwd, reportPath: path.join(cwd, "artifacts/context-eval-report.json") }, deps);

    assert.equal(calls, cases.length * 2);
    assert.equal(result.exitCode, 0);
    assert.equal(result.report.cases.length, cases.length);
    assert.deepEqual(await readFile(loaded.baselinePath), baselineBefore);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("returns non-zero when a case execution produces a hard failure", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "phase15d-runner-failure-"));
  try {
    const loaded = corpus([evalCase("broken")], cwd);
    await writeFile(loaded.baselinePath, "old baseline\n");
    await writeFile(loaded.policyPath, "old policy\n");
    const result = await runContextEval({ cwd, reportPath: path.join(cwd, "artifacts/context-eval-report.json") }, {
      loadCorpus: async () => loaded,
      executeCase: async () => { throw new Error("deterministic failure"); },
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.report.gateDecisions.isolation, false);
    assert.equal(result.report.cases[0]?.failures[0]?.gate, "isolation.execution");
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
