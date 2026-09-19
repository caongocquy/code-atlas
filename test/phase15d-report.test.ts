import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { buildMachineReport, renderHumanReport, writeReport } from "../eval/context/runner/report.js";
import type { AggregateScore, CaseScore, ObservedMetrics, ReportInput } from "../eval/context/types.js";

type TestReportInput = ReportInput & { baselineBytes?: Uint8Array; policyBytes?: Uint8Array };

const baselineBytes = Buffer.from('{"caseId":"stable","selectedItems":1}\n', "utf8");
const policyBytes = Buffer.from('{"policyVersion":"context-eval-policy-v1"}\n', "utf8");

function metrics(overrides: Partial<ObservedMetrics> = {}): ObservedMetrics {
  return {
    selectedItems: 1,
    estimatedTokens: 10,
    returnedBytes: 20,
    requiredHitRate: 1,
    supportingHitRate: 1,
    contextPrecision: 1,
    fullItems: 1,
    deltaItems: 0,
    unchangedItems: 0,
    rehydratedItems: 0,
    requestedBytes: 20,
    savedBytes: 0,
    reuseRate: 0,
    bodyResendCount: 1,
    timingsMs: { indexLoad: 3, compile: 5, lifecycleStart: 7, refresh: 11 },
    ...overrides,
  };
}

function input(overrides: Partial<TestReportInput> = {}): TestReportInput {
  const caseOne: CaseScore = {
    caseId: "case-one",
    metrics: metrics(),
    failures: [],
    gates: {
      correctness: true,
      determinism: true,
      reconstruction: true,
      authorityUncertainty: true,
      isolation: true,
      catastrophicQuality: true,
    },
  };
  const aggregate: AggregateScore = { metrics: metrics(), failures: [], aggregateQuality: true };
  return {
    corpusVersion: "context-eval-v1",
    baselineVersion: "context-eval-baseline-v1",
    policyVersion: "context-eval-policy-v1",
    baselineSha256: "unused",
    policySha256: "unused",
    cases: [caseOne],
    aggregate,
    baselineBytes,
    policyBytes,
    ...overrides,
  };
}

test("builds a byte-stable report with exact versions, raw-byte digests, and stable ordering", () => {
  const caseOne = input().cases[0]!;
  const caseZero = { ...caseOne, caseId: "case-zero" };
  const first = buildMachineReport(input({ cases: [caseOne, caseZero] }));
  const second = buildMachineReport(input({ cases: [caseZero, caseOne] }));

  assert.equal(first.reportSchemaVersion, "context-eval-report-v1");
  assert.equal(first.corpusVersion, "context-eval-v1");
  assert.equal(first.baselineVersion, "context-eval-baseline-v1");
  assert.equal(first.policyVersion, "context-eval-policy-v1");
  assert.equal(first.baselineSha256, createHash("sha256").update(baselineBytes).digest("hex"));
  assert.equal(first.policySha256, createHash("sha256").update(policyBytes).digest("hex"));
  assert.deepEqual(first.cases.map(({ caseId }) => caseId), ["case-one", "case-zero"]);
  assert.equal(JSON.stringify(first), JSON.stringify(second));
});

test("retains timing observations without making semantic gate decisions fail", () => {
  const timed = buildMachineReport(input());
  const differentTiming = buildMachineReport(input({ aggregate: { ...input().aggregate, metrics: metrics({ timingsMs: { indexLoad: 999, compile: 998, lifecycleStart: 997, refresh: 996 } }) } }));

  assert.deepEqual(timed.gateDecisions, differentTiming.gateDecisions);
  assert.deepEqual(timed.cases[0]?.metrics.timingsMs, metrics().timingsMs);
  assert.deepEqual(differentTiming.aggregate.timingsMs, { indexLoad: 999, compile: 998, lifecycleStart: 997, refresh: 996 });
});

test("rejects caller-supplied placeholder digests when raw identity bytes are absent", () => {
  for (const placeholder of ["0".repeat(64), "f".repeat(64)]) {
    const report = buildMachineReport(input({ baselineBytes: undefined, policyBytes: undefined, baselineSha256: placeholder, policySha256: placeholder }));
    assert.equal(report.gateDecisions.corpusIntegrity, false);
    assert.equal(report.failures.some(({ gate }) => gate === "integrity.baseline_digest"), true);
    assert.equal(report.failures.some(({ gate }) => gate === "integrity.policy_digest"), true);
  }
});

test("uses fixed code-unit ordering for case keys and failure details", () => {
  const first = input().cases[0]!;
  const second = { ...first, caseId: "\uFFFD" };
  const third = { ...first, caseId: "\uE000", failures: [{ gate: "z", scope: "case" as const, caseId: "\uE000", observed: true, expected: false, message: "z" }, { gate: "a", scope: "case" as const, caseId: "\uE000", observed: true, expected: false, message: "a" }] };
  const report = buildMachineReport(input({ cases: [second, third, first] }));

  assert.deepEqual(report.cases.map(({ caseId }) => caseId), ["case-one", "\uE000", "\uFFFD"]);
  assert.deepEqual(report.cases[1]?.failures.map(({ gate }) => gate), ["a", "z"]);
});

test("maps every hard failure family to a non-passing gate decision", () => {
  const failedCase: CaseScore = {
    ...input().cases[0]!,
    failures: [
      { gate: "correctness.required_hit_rate", scope: "case", caseId: "case-one", observed: 0, expected: 1, message: "missing" },
      { gate: "determinism.semantic", scope: "case", caseId: "case-one", observed: "a", expected: "b", message: "different" },
      { gate: "reconstruction.content", scope: "case", caseId: "case-one", observed: false, expected: true, message: "wrong" },
      { gate: "authority.false_required", scope: "case", caseId: "case-one", observed: 1, expected: 0, message: "promoted" },
      { gate: "isolation.workspace", scope: "case", caseId: "case-one", observed: false, expected: true, message: "leaked" },
      { gate: "quality.catastrophic.tokens", scope: "case", caseId: "case-one", observed: 3, expected: 2, message: "too large" },
    ],
    gates: { correctness: false, determinism: false, reconstruction: false, authorityUncertainty: false, isolation: false, catastrophicQuality: false },
  };
  const report = buildMachineReport(input({
    cases: [failedCase],
    aggregate: {
      ...input().aggregate,
      aggregateQuality: false,
      failures: [{ gate: "quality.aggregate.tokens", scope: "corpus", observed: 3, expected: 2, message: "too large" }, { gate: "corpus.version", scope: "integrity", observed: "bad", expected: "good", message: "mismatch" }],
    },
  }));

  assert.deepEqual(report.gateDecisions, {
    correctness: false,
    determinism: false,
    reconstruction: false,
    authorityUncertainty: false,
    isolation: false,
    catastrophicQuality: false,
    aggregateQuality: false,
    corpusIntegrity: false,
  });
  assert.match(renderHumanReport(report), /FAIL/);
  assert.match(renderHumanReport(report), /corpus\.version/);
  assert.match(renderHumanReport(report), /case-one/);
});

test("renders lifecycle delivery and reuse metrics in the human report", () => {
  const report = buildMachineReport(input({ aggregate: { ...input().aggregate, metrics: metrics({ fullItems: 2, deltaItems: 3, unchangedItems: 4, rehydratedItems: 5, reuseRate: 0.75, bodyResendCount: 6 }) } }));
  const human = renderHumanReport(report);

  assert.match(human, /Lifecycle: full=2, delta=3, unchanged=4, rehydrated=5, reuse=0\.75, resend=6/);
});

test("writes only the transient machine-report artifact", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "phase15d-report-"));
  try {
    await assert.rejects(writeReport(path.join(directory, "other.json"), buildMachineReport(input())), /transient.*context-eval-report\.json/);
    const target = path.join(directory, "artifacts", "context-eval-report.json");
    await writeReport(target, buildMachineReport(input()));
    assert.deepEqual(JSON.parse(await readFile(target, "utf8")), buildMachineReport(input()));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
