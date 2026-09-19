import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runContextEval, type EvalRunnerDeps } from "../eval/context/run.js";
import type { EvalCase, ObservedCase } from "../eval/context/types.js";
import { validateCorpusWorkspaceRefs, type LoadedCorpus } from "../eval/context/corpus/load-corpus.js";
import { buildMachineReport } from "../eval/context/runner/report.js";

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

function observed(caseId: string, estimatedTokens = 1): ObservedCase {
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
      estimatedTokens,
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

function failedReport(gate: string) {
  const caseFailure = { gate, scope: "case" as const, caseId: "one", observed: false, expected: true, message: gate };
  const metrics = observed("one").metrics;
  return buildMachineReport({
    corpusVersion: "context-eval-v1",
    baselineVersion: "context-eval-baseline-v1",
    policyVersion: "context-eval-policy-v1",
    baselineSha256: "unused",
    policySha256: "unused",
    baselineBytes: Buffer.from("baseline\n"),
    policyBytes: Buffer.from("policy\n"),
    cases: [{ caseId: "one", metrics, failures: [caseFailure], gates: { correctness: true, determinism: true, reconstruction: true, authorityUncertainty: true, isolation: true, catastrophicQuality: true } }],
    aggregate: { metrics, failures: [], aggregateQuality: true },
  });
}

function corpus(cases: readonly EvalCase[], cwd: string): LoadedCorpus {
  const corpusRoot = path.join(cwd, "eval/context/corpus");
  const baselineRoot = path.join(cwd, "eval/context/baselines");
  mkdirSync(baselineRoot, { recursive: true });
  for (const value of cases) mkdirSync(path.join(corpusRoot, value.workspaceRef), { recursive: true });
  return {
    manifestPath: path.join(corpusRoot, "manifest.json"),
    baselinePath: path.join(baselineRoot, "context-eval-v1.json"),
    policyPath: path.join(baselineRoot, "context-eval-policy-v1.json"),
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

test("classifies a missing workspace fixture as corpus integrity before execution", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "phase15d-runner-integrity-"));
  try {
    const loaded = corpus([evalCase("missing")], cwd);
    await rm(path.join(path.dirname(loaded.manifestPath), "synthetic/missing"), { recursive: true, force: true });
    assert.throws(() => validateCorpusWorkspaceRefs({ manifest: loaded.manifest, corpusRoot: path.dirname(loaded.manifestPath) }), /workspaceRef.*missing|fixture.*missing/);
    await writeFile(loaded.baselinePath, "old baseline\n");
    await writeFile(loaded.policyPath, "old policy\n");
    const result = await runContextEval({ cwd, reportPath: path.join(cwd, "artifacts/context-eval-report.json") }, {
      loadCorpus: async () => { throw new Error("Corpus integrity failure: workspaceRef fixture is missing"); },
      executeCase: async () => { throw new Error("must not execute"); },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.failures.some(({ gate }) => gate === "integrity.load"), true);
    assert.equal(result.report.gateDecisions.corpusIntegrity, false);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("maps aggregate, catastrophic, digest, and version failures to non-zero gate decisions", () => {
  assert.equal(failedReport("quality.aggregate.selected_items").gateDecisions.aggregateQuality, false);
  assert.equal(failedReport("quality.catastrophic.selected_items").gateDecisions.catastrophicQuality, false);

  const digestFailure = buildMachineReport({
    corpusVersion: "context-eval-v1", baselineVersion: "context-eval-baseline-v1", policyVersion: "context-eval-policy-v1",
    baselineSha256: "0".repeat(64), policySha256: "f".repeat(64), cases: [],
    aggregate: { metrics: observed("one").metrics, failures: [], aggregateQuality: true },
  });
  assert.equal(digestFailure.gateDecisions.corpusIntegrity, false);

  const versionFailure = buildMachineReport({
    corpusVersion: "context-eval-v2" as "context-eval-v1", baselineVersion: "context-eval-baseline-v1", policyVersion: "context-eval-policy-v1",
    baselineSha256: "unused", policySha256: "unused", baselineBytes: Buffer.from("baseline\n"), policyBytes: Buffer.from("policy\n"), cases: [],
    aggregate: { metrics: observed("one").metrics, failures: [], aggregateQuality: true },
  });
  assert.equal(versionFailure.gateDecisions.corpusIntegrity, false);
});

test("includes each determinism failure exactly once", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "phase15d-runner-determinism-"));
  try {
    const loaded = corpus([evalCase("one")], cwd);
    await writeFile(loaded.baselinePath, "old baseline\n");
    await writeFile(loaded.policyPath, "old policy\n");
    let call = 0;
    const result = await runContextEval({ cwd, reportPath: path.join(cwd, "artifacts/context-eval-report.json") }, {
      loadCorpus: async () => loaded,
      executeCase: async ({ evalCase: value }) => {
        call += 1;
        return observed(value.caseId, call === 1 ? 1 : 2);
      },
    });
    assert.equal(result.exitCode, 1);
    assert.equal(result.report.cases[0]?.failures.filter(({ gate }) => gate === "determinism.metrics").length, 1);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
