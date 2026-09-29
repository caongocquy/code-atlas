import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { updateContextBaseline } from "../eval/context/update-baseline.js";
import type { EvalCase, ObservedCase } from "../eval/context/types.js";
import type { LoadedCorpus } from "../eval/context/corpus/load-corpus.js";

function caseRecord(caseId: string, required = false): EvalCase {
  const subject = { kind: "file" as const, path: `${caseId}.ts` };
  return {
    caseId,
    kind: "synthetic",
    language: "typescript",
    syntheticClass: "exact-target",
    workspaceRef: `synthetic/${caseId}`,
    task: "read the target",
    anchors: [],
    changedPaths: [],
    truth: { requiredSubjects: required ? [subject] : [], supportingSubjects: [], forbiddenRequiredSubjects: [] },
  };
}

function observed(value: EvalCase, selected = false): ObservedCase {
  const subject = value.truth.requiredSubjects[0];
  return {
    caseId: value.caseId,
    repositoryIdentity: "repo",
    workspaceIdentity: "workspace",
    taskIdentity: "task",
    planIdentity: "plan",
    selectedItems: selected && subject ? [{ subject, priority: "required", rank: 1, reasons: ["test"] }] : [],
    reliability: { mayBeIncomplete: false, capabilityStates: {}, diagnostics: [] },
    deliveries: [], reconstructedContents: {}, lifecycleModes: [],
    metrics: { selectedItems: selected ? 1 : 0, estimatedTokens: 8, returnedBytes: 16, requiredHitRate: selected ? 1 : 0, supportingHitRate: 1, contextPrecision: 1, fullItems: 0, deltaItems: 0, unchangedItems: 0, rehydratedItems: 0, requestedBytes: 0, savedBytes: 0, reuseRate: 0, bodyResendCount: 0, timingsMs: { indexLoad: 1, compile: 1, lifecycleStart: 0, refresh: 0 } },
  };
}

function corpus(cases: readonly EvalCase[], cwd: string): LoadedCorpus {
  const corpusRoot = path.join(cwd, "eval/context/corpus");
  const baselineRoot = path.join(cwd, "eval/context/baselines");
  mkdirSync(baselineRoot, { recursive: true });
  for (const value of cases) mkdirSync(path.join(corpusRoot, value.workspaceRef), { recursive: true });
  return {
    manifestPath: path.join(corpusRoot, "manifest.json"), baselinePath: path.join(baselineRoot, "context-eval-v1.json"), policyPath: path.join(baselineRoot, "context-eval-policy-v1.json"),
    manifest: { corpusVersion: "context-eval-v1", cases, snapshots: [] },
    baseline: { corpusVersion: "context-eval-v1", baselineVersion: "context-eval-baseline-v1", policyVersion: "context-eval-policy-v1", entries: cases.map(({ caseId }) => ({ caseId, selectedItems: 1, estimatedTokens: 4, returnedBytes: 8, requiredHitRate: 1, supportingHitRate: 1, qualityOverrides: { aggregate: { maxSelectedItemsIncreasePct: 42 } } })) },
    policy: { policyVersion: "context-eval-policy-v1", aggregate: { maxEstimatedTokensIncreasePct: 10, maxReturnedBytesIncreasePct: 10, maxSelectedItemsIncreasePct: 10, maxRequiredHitRateDecreasePp: 0, maxSupportingHitRateDecreasePp: 5 }, catastrophic: { maxEstimatedTokensMultiplier: 2, maxReturnedBytesMultiplier: 2, selectedItemsFormula: "baselineSelectedItems + max(3, baselineSelectedItems)", requiredTargetsMayDisappear: false } },
    manifestSha256: "manifest", baselineSha256: "baseline", policySha256: "policy",
  };
}

test("exports the explicit baseline update entrypoint", () => {
  assert.equal(typeof updateContextBaseline, "function");
});

test("shows an old-to-new diff, preserves overrides, and stays read-only without write", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "phase15d-baseline-readonly-"));
  try {
    const value = caseRecord("one");
    const loaded = corpus([value], cwd);
    const old = JSON.stringify(loaded.baseline, null, 2) + "\n";
    await writeFile(loaded.baselinePath, old);
    await writeFile(loaded.policyPath, "policy bytes\n");
    const result = await updateContextBaseline({ cwd, write: false }, {
      loadCorpus: async () => loaded,
      executeCase: async () => observed(value),
    });

    assert.equal(result.wrote, false);
    assert.match(result.diff, /one\.estimatedTokens: 4 -> 8/);
    assert.deepEqual(result.candidate.entries[0]?.qualityOverrides, loaded.baseline.entries[0]?.qualityOverrides);
    assert.equal(await readFile(loaded.baselinePath, "utf8"), old);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("writes a candidate only with explicit write and refuses correctness failures", async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), "phase15d-baseline-write-"));
  try {
    const good = caseRecord("good");
    const loaded = corpus([good], cwd);
    await writeFile(loaded.baselinePath, JSON.stringify(loaded.baseline, null, 2));
    await writeFile(loaded.policyPath, "policy bytes\n");
    const written = await updateContextBaseline({ cwd, write: true }, { loadCorpus: async () => loaded, executeCase: async () => observed(good) });
    assert.equal(written.wrote, true);
    assert.equal(JSON.parse(await readFile(loaded.baselinePath, "utf8")).entries[0].estimatedTokens, 8);

    const bad = caseRecord("bad", true);
    const badCorpus = corpus([bad], cwd);
    await writeFile(badCorpus.baselinePath, JSON.stringify(badCorpus.baseline, null, 2));
    await writeFile(badCorpus.policyPath, "policy bytes\n");
    await assert.rejects(updateContextBaseline({ cwd, write: true }, { loadCorpus: async () => badCorpus, executeCase: async () => observed(bad, false) }), /correctness gates failed/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
