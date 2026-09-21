import { affectedTestsFromChange } from "../change/affected-tests.service.js";
import { analyzeInspectChangeFromContext } from "../change/inspect-change.service.js";
import { evaluateArchitectureChangeUnderPolicy } from "../architecture/architecture-drift.service.js";
import { loadArchitecturePolicySnapshots } from "../architecture/architecture-policy-snapshot.js";
import { createCoverageDiagnostics, mergeCoverageDiagnostics } from "../diagnostics/coverage-diagnostics.service.js";
import type { CoverageGapKind } from "../diagnostics/coverage-diagnostics.types.js";
import type { ArchitectureCause, ArchitectureFindingKind } from "../architecture/architecture-drift.types.js";
import type { ArchitectureSeverity } from "../architecture/architecture-policy.js";
import type { ChangeGatePolicy, ChangeGatePolicyPair, ChangeGateInput, ChangeGateResult, GateCheck, GateCheckStatus, GateEvidence, GateSummary, GateStatus } from "./change-gate.types.js";
import { loadChangeGatePolicySnapshots } from "./change-gate-policy.js";
import { compareGraphDeltaContext, readGraphDeltaContext } from "../change/graph-delta.service.js";

const severityRank = { low: 0, medium: 1, high: 2 } as const;
const allFindingKinds: ArchitectureFindingKind[] = ["forbidden_dependency", "dependency_cycle", "unclassified_dependency"];
const defaultCauses: ArchitectureCause[] = ["code_change", "both"];

type Bundle = {
  change: Awaited<ReturnType<typeof analyzeInspectChangeFromContext>>["result"];
  tests: Awaited<ReturnType<typeof affectedTestsFromChange>>;
  architecture: Awaited<ReturnType<typeof evaluateArchitectureChangeUnderPolicy>>;
  diagnostics: Awaited<ReturnType<typeof createCoverageDiagnostics>>;
};

function architectureOnlyDiagnostics(bundle: Bundle): Awaited<ReturnType<typeof createCoverageDiagnostics>> {
  const ambiguity = bundle.architecture.diagnostics.gaps.find((gap) => gap.kind === "ambiguous_architecture_membership");
  return createCoverageDiagnostics(ambiguity ? {
    architectureAmbiguities: ambiguity.count,
    architectureAmbiguityFiles: ambiguity.files,
  } : {});
}

function summary(checks: GateCheck[]): GateSummary {
  return checks.reduce((result, check) => {
    if (check.status === "pass") result.passed += 1;
    if (check.status === "fail") result.failed += 1;
    if (check.status === "warn") result.warnings += 1;
    if (check.status === "skipped") result.skipped += 1;
    return result;
  }, { passed: 0, failed: 0, warnings: 0, skipped: 0 });
}

function evidenceGap(kind: CoverageGapKind, count: number, detail: string): GateEvidence {
  return { kind: "diagnostic_gap", detail: `${kind}: ${count} · ${detail}` };
}

function testsEvidence(bundle: Bundle): GateCheck["evidence"] {
  return bundle.tests.uncoveredAffectedSymbols.slice(0, 20).map((symbol) => ({
    kind: "test_gap",
    detail: "no indexed structural test evidence",
    file: symbol.file,
  }));
}

function evaluate(policy: ChangeGatePolicy, bundle: Bundle): GateCheck[] {
  const checks: GateCheck[] = [];
  const add = (check: GateCheck) => checks.push(check);
  if (policy.risk) {
    const allowUnknown = policy.risk.allowUnknown ?? false;
    if (bundle.change.risk === "unknown") {
      add({ id: "risk.allowUnknown", category: "risk", status: allowUnknown ? "pass" : "fail", message: allowUnknown ? "Unknown risk is allowed." : "Risk is unknown and unknown risk is not allowed.", actual: "unknown", expected: allowUnknown });
      if (policy.risk.maxAllowed) add({ id: "risk.maxAllowed", category: "risk", status: "skipped", message: "Maximum risk was skipped because risk is unknown.", actual: "unknown", expected: policy.risk.maxAllowed });
    } else if (policy.risk.maxAllowed) {
      const passed = severityRank[bundle.change.risk] <= severityRank[policy.risk.maxAllowed];
      add({ id: "risk.maxAllowed", category: "risk", status: passed ? "pass" : "fail", message: passed ? `Risk ${bundle.change.risk} is within the allowed maximum.` : `Risk ${bundle.change.risk} exceeds the allowed maximum.`, actual: bundle.change.risk, expected: { max: policy.risk.maxAllowed } });
    } else if (policy.risk.allowUnknown !== undefined) add({ id: "risk.allowUnknown", category: "risk", status: "skipped", message: "Unknown-risk policy is not needed for a classified risk.", actual: bundle.change.risk, expected: allowUnknown });
  }
  if (policy.tests?.maxUncoveredAffectedSymbols !== undefined) {
    const actual = bundle.tests.summary.uncoveredAffectedSymbols;
    const passed = actual <= policy.tests.maxUncoveredAffectedSymbols;
    add({ id: "tests.maxUncoveredAffectedSymbols", category: "tests", status: passed ? "pass" : "fail", message: `${actual} affected production symbol${actual === 1 ? " has" : "s have"} no indexed structural test evidence.`, actual, expected: { max: policy.tests.maxUncoveredAffectedSymbols }, evidence: passed ? undefined : testsEvidence(bundle) });
  }
  if (policy.tests?.minStructuralTestEvidenceRatio !== undefined) {
    const total = bundle.tests.summary.affectedProductionSymbols;
    if (total === 0) add({ id: "tests.minStructuralTestEvidenceRatio", category: "tests", status: "skipped", message: "No affected production symbols; structural test evidence ratio is not applicable.", actual: 0, expected: { min: policy.tests.minStructuralTestEvidenceRatio } });
    else {
      const ratio = bundle.tests.summary.symbolsWithTestEvidence / total;
      const passed = ratio >= policy.tests.minStructuralTestEvidenceRatio;
      add({ id: "tests.minStructuralTestEvidenceRatio", category: "tests", status: passed ? "pass" : "fail", message: `Structural test evidence covers ${bundle.tests.summary.symbolsWithTestEvidence} of ${total} affected production symbols.`, actual: ratio, expected: { min: policy.tests.minStructuralTestEvidenceRatio }, evidence: passed ? undefined : testsEvidence(bundle) });
    }
  }
  if (policy.diagnostics?.requireAuthoritativeNegativeResults === true) {
    const passed = bundle.diagnostics.authoritativeNegativeResults;
    add({ id: "diagnostics.authoritativeNegativeResults", category: "diagnostics", status: passed ? "pass" : "fail", message: passed ? "Negative results are authoritative within the available evidence." : "Negative results are not authoritative.", actual: passed, expected: true, evidence: passed ? undefined : bundle.diagnostics.gaps.slice(0, 10).map((gap) => ({ kind: "diagnostic_gap", detail: `${gap.kind}: ${gap.count}` })) });
  }
  if (policy.diagnostics?.forbidGapKinds) {
    const forbidden = bundle.diagnostics.gaps.filter((gap) => policy.diagnostics!.forbidGapKinds!.includes(gap.kind));
    add({ id: "diagnostics.forbidGapKinds", category: "diagnostics", status: forbidden.length ? "fail" : "pass", message: forbidden.length ? `Forbidden diagnostic gaps present: ${forbidden.map((gap) => `${gap.kind} (${gap.count})`).join(", ")}.` : "No forbidden diagnostic gaps are present.", actual: forbidden.length, expected: policy.diagnostics.forbidGapKinds.join(", "), evidence: forbidden.flatMap((gap) => evidenceGap(gap.kind, gap.count, "configured gap kind")) });
  }
  if (policy.architecture?.failOnSeverityAtLeast) {
    const causes = policy.architecture.causes ?? defaultCauses;
    const kinds = policy.architecture.kinds ?? allFindingKinds;
    const threshold = severityRank[policy.architecture.failOnSeverityAtLeast];
    const relevant = bundle.architecture.introduced.filter((finding) => causes.includes(finding.cause) && kinds.includes(finding.kind));
    const failures = relevant.filter((finding) => severityRank[finding.severity] >= threshold);
    let status: GateCheckStatus = failures.length ? "fail" : "pass";
    let message = failures.length ? `${failures.length} introduced architecture finding${failures.length === 1 ? "" : "s"} meet the configured severity threshold.` : "No introduced architecture findings meet the configured severity threshold.";
    if (!failures.length && !bundle.architecture.authoritativeNegativeResults) { status = "warn"; message += " Absence of additional findings is not authoritative."; }
    add({ id: "architecture.introducedSeverity", category: "architecture", status, message, actual: relevant.length, expected: { atLeast: policy.architecture.failOnSeverityAtLeast }, evidence: failures.slice(0, 20).map((finding) => ({ kind: "architecture_finding", id: finding.id, detail: `${finding.severity} ${finding.kind} (${finding.cause})`, file: finding.from?.file })) });
    const observations = bundle.architecture.introduced.filter((finding) => !causes.includes(finding.cause) || !kinds.includes(finding.kind) || severityRank[finding.severity] < threshold);
    if (observations.length > 0) add({ id: "architecture.observations", category: "architecture", status: "warn", message: `${observations.length} introduced architecture finding${observations.length === 1 ? "" : "s"} remain observable but do not meet the configured enforcement filters.`, actual: observations.length, evidence: observations.slice(0, 20).map((finding) => ({ kind: "architecture_finding", id: finding.id, detail: `${finding.severity} ${finding.kind} (${finding.cause})`, file: finding.from?.file })) });
  }
  return checks;
}

function statusFor(checks: GateCheck[]): GateStatus { return checks.some((check) => check.status === "fail") ? "fail" : "pass"; }

function policyMetadata(pair: ChangeGatePolicyPair, enforcementSource: "baseline" | "target_bootstrap" | "none"): ChangeGateResult["policy"] {
  return {
    configured: enforcementSource !== "none",
    enforcementSource,
    baseline: { configured: pair.baseline.configured, path: pair.path, ...(pair.baseline.semanticHash ? { semanticHash: pair.baseline.semanticHash } : {}), sourceKind: pair.baseline.source.kind },
    target: { configured: pair.target.configured, path: pair.path, ...(pair.target.semanticHash ? { semanticHash: pair.target.semanticHash } : {}), sourceKind: pair.target.source.kind },
    semanticChanged: pair.semanticChanged,
  };
}

export async function changeGate(repoPath: string, input: ChangeGateInput = {}): Promise<ChangeGateResult> {
  if (Object.hasOwn(input, "configPath")) {
    throw new Error("Change Gate always uses the repository-root codeatlas.config.json; configPath is not supported.");
  }
  const context = await readGraphDeltaContext(repoPath, input);
  const pair = await loadChangeGatePolicySnapshots(repoPath, context);
  const architecturePolicies = await loadArchitecturePolicySnapshots(repoPath, context);
  const enforcementSource = pair.baseline.configured ? "baseline" : pair.target.configured ? "target_bootstrap" : "none";
  if (enforcementSource === "none") {
    return { source: context.changes.source, status: "not_configured", policy: policyMetadata(pair, enforcementSource), summary: { passed: 0, failed: 0, warnings: 0, skipped: 0 }, checks: [], diagnostics: createCoverageDiagnostics() };
  }
  const analysis = analyzeInspectChangeFromContext(input, context);
  const change = analysis.result;
  const tests = await affectedTestsFromChange(repoPath, input, change, analysis);
  const delta = compareGraphDeltaContext(context, input);
  const enforced = pair.baseline.configured ? pair.baseline.policy! : pair.target.policy!;
  const enforcedArchitecturePolicy = pair.baseline.configured
    ? architecturePolicies.baseline.policy
    : architecturePolicies.target.policy;
  const architecture = evaluateArchitectureChangeUnderPolicy(context, enforcedArchitecturePolicy, input, delta);
  const diagnostics = mergeCoverageDiagnostics(tests.diagnostics, architectureOnlyDiagnostics({ change, tests, architecture, diagnostics: tests.diagnostics }));
  const enforcedBundle: Bundle = { change, tests, architecture, diagnostics };
  const checks = evaluate(enforced, enforcedBundle);
  const result: ChangeGateResult = { source: change.source, status: statusFor(checks), policy: policyMetadata(pair, enforcementSource), summary: summary(checks), checks, diagnostics };
  if (pair.baseline.configured && pair.semanticChanged) {
    const previewArchitecture = pair.target.configured
      ? evaluateArchitectureChangeUnderPolicy(context, architecturePolicies.target.policy, input, delta)
      : architecture;
    const previewBundle: Bundle = {
      change,
      tests,
      architecture: previewArchitecture,
      diagnostics: mergeCoverageDiagnostics(tests.diagnostics, architectureOnlyDiagnostics({ change, tests, architecture: previewArchitecture, diagnostics: tests.diagnostics })),
    };
    const previewChecks = pair.target.configured ? evaluate(pair.target.policy!, previewBundle) : [];
    result.preview = pair.target.configured
      ? { policy: "target", status: statusFor(previewChecks), checks: previewChecks, summary: summary(previewChecks) }
      : { policy: "target", status: "not_configured", checks: [], summary: { passed: 0, failed: 0, warnings: 0, skipped: 0 } };
  }
  return result;
}
