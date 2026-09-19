import { createHash } from "node:crypto";
import { mkdir, writeFile as writeFileToDisk } from "node:fs/promises";
import path from "node:path";

import { BASELINE_VERSION, CORPUS_VERSION, POLICY_VERSION, REPORT_SCHEMA_VERSION, type AggregateScore, type CaseScore, type GateFailure, type MachineReport, type ReportInput } from "../types.js";

type ReportBytes = Uint8Array | string;
type ReportInputWithBytes = Omit<ReportInput, "baselineSha256" | "policySha256"> & {
  baselineSha256?: string;
  policySha256?: string;
  baselineBytes?: ReportBytes;
  policyBytes?: ReportBytes;
};

function compareCodeUnits(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function digest(value: ReportBytes): string {
  return createHash("sha256").update(typeof value === "string" ? Buffer.from(value, "utf8") : value).digest("hex");
}

function stableValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(stableValue) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([left], [right]) => compareCodeUnits(left, right)).map(([key, item]) => [key, stableValue(item)])) as T;
  }
  return value;
}

function failureKey(value: GateFailure): string {
  return [value.scope, value.caseId ?? "", value.gate, String(value.observed), String(value.expected), value.message].join("\u0000");
}

function sortFailures(values: readonly GateFailure[]): readonly GateFailure[] {
  return [...values].sort((left, right) => compareCodeUnits(failureKey(left), failureKey(right))).map(stableValue);
}

function sortCases(values: readonly CaseScore[]): readonly CaseScore[] {
  return [...values].sort((left, right) => compareCodeUnits(left.caseId, right.caseId));
}

function hasFailure(failures: readonly GateFailure[], prefixes: readonly string[]): boolean {
  return failures.some(({ gate }) => prefixes.some((prefix) => gate === prefix || gate.startsWith(`${prefix}.`)));
}

function reportGateDecisions(cases: readonly CaseScore[], aggregate: AggregateScore, integrity: boolean): MachineReport["gateDecisions"] {
  const allFailures = [...cases.flatMap(({ failures }) => failures), ...aggregate.failures];
  const failed = (prefixes: readonly string[]) => !hasFailure(allFailures, prefixes);
  return {
    correctness: cases.every(({ gates }) => gates.correctness) && failed(["correctness"]),
    determinism: cases.every(({ gates }) => gates.determinism) && failed(["determinism"]),
    reconstruction: cases.every(({ gates }) => gates.reconstruction) && failed(["reconstruction"]),
    authorityUncertainty: cases.every(({ gates }) => gates.authorityUncertainty) && failed(["authority", "uncertainty"]),
    isolation: cases.every(({ gates }) => gates.isolation === true) && failed(["isolation", "lifecycle"]),
    catastrophicQuality: cases.every(({ gates }) => gates.catastrophicQuality) && failed(["quality.catastrophic"]),
    aggregateQuality: aggregate.aggregateQuality && !hasFailure(allFailures, ["quality.aggregate"]),
    corpusIntegrity: integrity && !hasFailure(allFailures, ["corpus", "integrity"]),
  };
}

function validDigest(value: string | undefined): boolean {
  return value !== undefined && /^[0-9a-f]{64}$/.test(value) && !/^([0-9a-f])\1{63}$/.test(value);
}

export function buildMachineReport(input: ReportInputWithBytes): MachineReport {
  const cases = sortCases(input.cases).map(({ caseId, metrics, failures }) => ({
    caseId,
    metrics: stableValue(metrics),
    failures: sortFailures(failures),
  }));
  const aggregateFailures = sortFailures(input.aggregate.failures);
  const integrityFailures: GateFailure[] = [];
  if (input.corpusVersion !== CORPUS_VERSION) integrityFailures.push({ gate: "integrity.corpus_version", scope: "integrity", observed: input.corpusVersion, expected: CORPUS_VERSION, message: "Report input uses an unsupported corpus version" });
  if (input.baselineVersion !== BASELINE_VERSION) integrityFailures.push({ gate: "integrity.baseline_version", scope: "integrity", observed: input.baselineVersion, expected: BASELINE_VERSION, message: "Report input uses an unsupported baseline version" });
  if (input.policyVersion !== POLICY_VERSION) integrityFailures.push({ gate: "integrity.policy_version", scope: "integrity", observed: input.policyVersion, expected: POLICY_VERSION, message: "Report input uses an unsupported policy version" });

  const baselineSha256 = input.baselineBytes === undefined ? input.baselineSha256 ?? "" : digest(input.baselineBytes);
  const policySha256 = input.policyBytes === undefined ? input.policySha256 ?? "" : digest(input.policyBytes);
  if (!validDigest(baselineSha256)) integrityFailures.push({ gate: "integrity.baseline_digest", scope: "integrity", observed: baselineSha256, expected: "a non-degenerate lowercase SHA-256 digest", message: "Baseline identity must be a non-degenerate lowercase SHA-256 digest" });
  if (!validDigest(policySha256)) integrityFailures.push({ gate: "integrity.policy_digest", scope: "integrity", observed: policySha256, expected: "a non-degenerate lowercase SHA-256 digest", message: "Policy identity must be a non-degenerate lowercase SHA-256 digest" });
  const failures = [...aggregateFailures, ...integrityFailures];
  const integrity = integrityFailures.length === 0 && !hasFailure([...input.cases.flatMap(({ failures }) => failures), ...aggregateFailures], ["corpus", "integrity"]);

  return stableValue({
    reportSchemaVersion: REPORT_SCHEMA_VERSION,
    corpusVersion: input.corpusVersion,
    baselineVersion: input.baselineVersion,
    baselineSha256,
    policyVersion: input.policyVersion,
    policySha256,
    cases,
    aggregate: stableValue(input.aggregate.metrics),
    failures: sortFailures(failures),
    gateDecisions: reportGateDecisions(input.cases, { ...input.aggregate, failures }, integrity),
  });
}

export function renderHumanReport(report: MachineReport): string {
  const decisions = Object.entries(report.gateDecisions).map(([gate, passed]) => `${gate}: ${passed ? "PASS" : "FAIL"}`);
  const failures = [...report.cases.flatMap(({ failures }) => failures), ...report.failures];
  const lines = [
    `Phase15D context evaluation: ${Object.values(report.gateDecisions).every(Boolean) ? "PASS" : "FAIL"}`,
    `Corpus: ${report.corpusVersion} | cases: ${report.cases.length}`,
    `Baseline: ${report.baselineVersion} (${report.baselineSha256})`,
    `Policy: ${report.policyVersion} (${report.policySha256})`,
    "Gate decisions:",
    ...decisions.map((value) => `  ${value}`),
    `Quality: selected=${report.aggregate.selectedItems}, tokens=${report.aggregate.estimatedTokens}, bytes=${report.aggregate.returnedBytes}`,
    `Lifecycle: full=${report.aggregate.fullItems}, delta=${report.aggregate.deltaItems}, unchanged=${report.aggregate.unchangedItems}, rehydrated=${report.aggregate.rehydratedItems}, reuse=${report.aggregate.reuseRate}, resend=${report.aggregate.bodyResendCount}`,
    `Performance observations (non-blocking): ${JSON.stringify(report.aggregate.timingsMs)}`,
  ];
  if (failures.length > 0) {
    lines.push("Failures:", ...failures.map((failure) => `  [${failure.scope}] ${failure.caseId ?? "corpus"} ${failure.gate}: ${failure.message} (observed=${String(failure.observed)}, expected=${String(failure.expected)})`));
  }
  return `${lines.join("\n")}\n`;
}

export async function writeReport(filePath: string, report: MachineReport): Promise<void> {
  const resolved = path.resolve(filePath);
  if (path.basename(resolved) !== "context-eval-report.json" || path.basename(path.dirname(resolved)) !== "artifacts") {
    throw new Error("Reports may only be written to the transient artifacts/context-eval-report.json path");
  }
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFileToDisk(resolved, `${JSON.stringify(stableValue(report), null, 2)}\n`, "utf8");
}
