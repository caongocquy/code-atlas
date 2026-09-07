import fs from "node:fs/promises";
import path from "node:path";

import { getRepositoryIdentity } from "../repository/repository-identity.js";
import { getRepositoryStatusReadOnly } from "../repository/repository-status.service.js";
import type { ResolutionCoverage, ResolutionDiagnostic } from "../graph/resolution.types.js";
import { AtlasStore } from "../../storage/atlas/atlas.store.js";
import type {
  CoverageDiagnostics,
  CoverageDiagnosticsInput,
  CoverageGap,
  CoverageGapKind,
  CoverageMetric,
  VerificationTarget,
} from "./coverage-diagnostics.types.js";

const GAP_ORDER: CoverageGapKind[] = [
  "ambiguous_target",
  "broken_internal_import",
  "dynamic_dispatch",
  "missing_caller_context",
  "parser_error",
  "unsupported_construct",
  "unmapped_change_range",
  "missing_baseline",
  "binary_change",
  "truncated_analysis",
  "stale_index",
  "not_indexed",
  "ambiguous_architecture_membership",
];
const MAX_VERIFICATION_TARGETS = 100;

type GapAccumulator = {
  count: number;
  files: Set<string>;
  details: Set<string>;
};

function addReason(reasons: Set<string>, reason: string): void {
  if (reason) reasons.add(reason);
}

function gapReason(kind: CoverageGapKind, count: number): string {
  const labels: Record<CoverageGapKind, string> = {
    dynamic_dispatch: "dynamic dispatch limits reliable internal resolution",
    ambiguous_target: "ambiguous targets prevent authoritative resolution",
    missing_caller_context: "caller context is unavailable for some references",
    broken_internal_import: "internal imports could not be resolved",
    parser_error: "parser errors limited structural evidence",
    unsupported_construct: "unsupported constructs limited structural evidence",
    unmapped_change_range: "changed ranges could not be mapped reliably",
    missing_baseline: "baseline symbol evidence is missing",
    binary_change: "binary changes have no source symbol mapping",
    truncated_analysis: "analysis was truncated by an explicit bound",
    stale_index: "the graph index is stale and may not reflect current source",
    not_indexed: "the graph index is not present",
    ambiguous_architecture_membership: "architecture group membership is ambiguous",
  };
  return `${count} ${labels[kind]}`;
}

function diagnosticGap(diagnostic: ResolutionDiagnostic): {
  kind?: CoverageGapKind;
  detail: string;
} {
  if (diagnostic.kind === "ambiguous") {
    return { kind: "ambiguous_target", detail: diagnostic.ambiguityReason };
  }
  if (diagnostic.unsupportedDynamic) return { kind: "dynamic_dispatch", detail: diagnostic.reason };
  if (diagnostic.reason.includes("external dependency") || diagnostic.reason.includes("builtin dependency")) {
    return { detail: diagnostic.reason };
  }
  if (diagnostic.reason.includes("caller identity")) {
    return { kind: "missing_caller_context", detail: diagnostic.reason };
  }
  if (diagnostic.reason.includes("broken internal import")) {
    return { kind: "broken_internal_import", detail: diagnostic.reason };
  }
  if (diagnostic.reason.includes("unsupported")) {
    return { kind: "unsupported_construct", detail: diagnostic.reason };
  }
  if (diagnostic.reason.includes("no unique parent") || diagnostic.reason.includes("not unique")) {
    return { kind: "ambiguous_target", detail: diagnostic.reason };
  }
  return { detail: diagnostic.reason };
}

function addGap(
  gaps: Map<CoverageGapKind, GapAccumulator>,
  kind: CoverageGapKind,
  count = 1,
  files: readonly string[] = [],
  details: readonly string[] = [],
): void {
  if (count <= 0) return;
  const current = gaps.get(kind) ?? { count: 0, files: new Set(), details: new Set() };
  current.count += count;
  files.forEach((file) => current.files.add(file));
  details.forEach((detail) => current.details.add(detail));
  gaps.set(kind, current);
}

function addResolutionDiagnostics(
  gaps: Map<CoverageGapKind, GapAccumulator>,
  diagnostics: readonly ResolutionDiagnostic[],
): Map<CoverageGapKind, number> {
  const counts = new Map<CoverageGapKind, number>();
  for (const diagnostic of diagnostics) {
    const mapped = diagnosticGap(diagnostic);
    if (mapped.kind) {
      addGap(gaps, mapped.kind, 1, [diagnostic.source.file], [mapped.detail]);
      counts.set(mapped.kind, (counts.get(mapped.kind) ?? 0) + 1);
    }
  }
  return counts;
}

function addResolutionCoverage(
  gaps: Map<CoverageGapKind, GapAccumulator>,
  coverage: ResolutionCoverage | undefined,
  diagnosticCounts: Map<CoverageGapKind, number>,
): void {
  if (!coverage) return;
  addGap(gaps, "dynamic_dispatch", Math.max(0, coverage.unsupportedDynamic - (diagnosticCounts.get("dynamic_dispatch") ?? 0)));
  addGap(gaps, "ambiguous_target", Math.max(0, coverage.ambiguousCalls + coverage.ambiguousExtends - (diagnosticCounts.get("ambiguous_target") ?? 0)));
  addGap(gaps, "parser_error", coverage.parserErrors);
}

function metric(input: CoverageDiagnosticsInput["internalCallResolution"]): CoverageMetric[] {
  if (!input || !Number.isInteger(input.resolved) || !Number.isInteger(input.total) || input.total <= 0) return [];
  if (input.resolved < 0 || input.resolved > input.total) return [];
  return [{
    name: "internalCallResolution",
    resolved: input.resolved,
    total: input.total,
    ratio: input.resolved / input.total,
  }];
}

function buildGaps(input: CoverageDiagnosticsInput): Map<CoverageGapKind, GapAccumulator> {
  const gaps = new Map<CoverageGapKind, GapAccumulator>();
  const diagnosticCounts = addResolutionDiagnostics(gaps, input.resolutionDiagnostics ?? []);
  addResolutionCoverage(gaps, input.resolutionCoverage, diagnosticCounts);

  if (input.graphState === "not_indexed") addGap(gaps, "not_indexed");
  if (input.graphState === "stale") addGap(gaps, "stale_index");

  const change = input.change;
  if (change) {
    const changedFiles = change.files ?? [];
    const binaryFiles = changedFiles.filter((file) => file.status === "binary").map((file) => file.path);
    addGap(gaps, "binary_change", binaryFiles.length, binaryFiles);
    const unmappedFiles = change.unmappedFiles ?? [];
    addGap(gaps, "unmapped_change_range", change.unmappedHunks ?? 0, unmappedFiles);
    addGap(gaps, "missing_baseline", change.missingBaseline ?? 0);
    if (change.reasons?.some((reason) => reason.includes("truncated"))) addGap(gaps, "truncated_analysis");
  }
  if (input.tests?.reasons?.some((reason) => reason.includes("truncated"))) addGap(gaps, "truncated_analysis");
  if (input.tests?.indexUnavailable) addGap(gaps, "not_indexed");
  addGap(gaps, "ambiguous_architecture_membership", input.architectureAmbiguities ?? 0, input.architectureAmbiguityFiles ?? []);
  return gaps;
}

function buildTargets(
  gaps: Map<CoverageGapKind, GapAccumulator>,
  input: CoverageDiagnosticsInput,
): { targets: VerificationTarget[]; truncated: boolean } {
  const targets = new Map<string, VerificationTarget>();
  const add = (target: VerificationTarget) => targets.set(`${target.file}\0${target.symbolId ?? ""}\0${target.reason}`, target);
  for (const [kind, value] of gaps) {
    const reason = gapReason(kind, value.count);
    for (const file of value.files) add({ file, reason });
  }
  for (const symbol of input.tests?.uncoveredAffectedSymbols ?? []) {
    add({ file: symbol.file, symbolId: symbol.symbolId, reason: "no indexed structural test evidence found" });
  }
  for (const file of input.tests?.uncoveredAffectedFiles ?? []) {
    add({ file, reason: "no indexed structural test evidence found for the changed file" });
  }
  const ordered = [...targets.values()].sort((left, right) => left.file.localeCompare(right.file)
    || (left.symbolId ?? "").localeCompare(right.symbolId ?? "")
    || left.reason.localeCompare(right.reason));
  return { targets: ordered.slice(0, MAX_VERIFICATION_TARGETS), truncated: ordered.length > MAX_VERIFICATION_TARGETS };
}

export function createCoverageDiagnostics(input: CoverageDiagnosticsInput = {}): CoverageDiagnostics {
  const gaps = buildGaps(input);
  const targetResult = buildTargets(gaps, input);
  if (targetResult.truncated) addGap(gaps, "truncated_analysis", 1, [], [`verification targets capped at ${MAX_VERIFICATION_TARGETS}`]);
  const reasons = new Set<string>();
  for (const [kind, value] of gaps) addReason(reasons, gapReason(kind, value.count));
  for (const reason of input.change?.reasons ?? []) addReason(reasons, reason);
  for (const reason of input.tests?.reasons ?? []) addReason(reasons, reason);
  if (input.graphState === "not_indexed") addReason(reasons, "Run `code-atlas index` to build structural evidence.");
  if (input.graphState === "stale") addReason(reasons, "Run `code-atlas sync` to refresh structural evidence.");

  const serialized: CoverageGap[] = [...gaps.entries()]
    .sort(([left], [right]) => GAP_ORDER.indexOf(left) - GAP_ORDER.indexOf(right))
    .map(([kind, value]) => ({
      kind,
      count: value.count,
      ...(value.files.size > 0 ? { files: [...value.files].sort() } : {}),
      ...(value.details.size > 0 ? { details: [...value.details].sort() } : {}),
    }));
  const mayBeIncomplete = input.graphState === "not_indexed" || input.graphState === "stale"
    || input.resolutionCoverage?.mayBeIncomplete === true
    || input.change?.mayBeIncomplete === true
    || input.tests?.mayBeIncomplete === true
    || serialized.length > 0;
  return {
    mayBeIncomplete,
    authoritativeNegativeResults: !mayBeIncomplete,
    gaps: serialized,
    metrics: metric(input.internalCallResolution),
    verificationTargets: targetResult.targets,
    reasons: [...reasons],
  };
}

export function mergeCoverageDiagnostics(...values: CoverageDiagnostics[]): CoverageDiagnostics {
  return mergeSerializedDiagnostics(values);
}

function mergeSerializedDiagnostics(values: CoverageDiagnostics[]): CoverageDiagnostics {
  const gaps = new Map<CoverageGapKind, GapAccumulator>();
  const metrics = new Map<string, CoverageMetric>();
  const targets = new Map<string, VerificationTarget>();
  const reasons = new Set<string>();
  for (const value of values) {
    for (const gap of value.gaps) {
      const singleton = gap.kind === "not_indexed" || gap.kind === "stale_index";
      const existing = gaps.get(gap.kind)?.count ?? 0;
      addGap(gaps, gap.kind, singleton ? Math.max(0, 1 - existing) : gap.count, gap.files, gap.details);
    }
    for (const metricValue of value.metrics) metrics.set(metricValue.name, metricValue);
    for (const target of value.verificationTargets) targets.set(`${target.file}\0${target.symbolId ?? ""}\0${target.reason}`, target);
    value.reasons.forEach((reason) => reasons.add(reason));
  }
  const orderedTargets = [...targets.values()].sort((left, right) => left.file.localeCompare(right.file) || (left.symbolId ?? "").localeCompare(right.symbolId ?? "") || left.reason.localeCompare(right.reason));
  if (orderedTargets.length > MAX_VERIFICATION_TARGETS) {
    addGap(gaps, "truncated_analysis", 1, [], [`verification targets capped at ${MAX_VERIFICATION_TARGETS}`]);
  }
  const serialized = [...gaps.entries()]
    .sort(([left], [right]) => GAP_ORDER.indexOf(left) - GAP_ORDER.indexOf(right))
    .map(([kind, value]) => ({ kind, count: value.count, ...(value.files.size ? { files: [...value.files].sort() } : {}), ...(value.details.size ? { details: [...value.details].sort() } : {}) }));
  const mayBeIncomplete = values.some((value) => value.mayBeIncomplete) || orderedTargets.length > MAX_VERIFICATION_TARGETS;
  return {
    mayBeIncomplete,
    authoritativeNegativeResults: !mayBeIncomplete && values.every((value) => value.authoritativeNegativeResults),
    gaps: serialized,
    metrics: [...metrics.values()].sort((left, right) => left.name.localeCompare(right.name)),
    verificationTargets: orderedTargets.slice(0, MAX_VERIFICATION_TARGETS),
    reasons: [...reasons],
  };
}

export async function repositoryCoverageDiagnostics(repoPath: string): Promise<CoverageDiagnostics> {
  const databasePath = path.join(repoPath, ".codeatlas", "atlas.db");
  try {
    await fs.access(databasePath);
  } catch {
    return createCoverageDiagnostics({ graphState: "not_indexed" });
  }

  const identity = getRepositoryIdentity(repoPath);
  const status = await getRepositoryStatusReadOnly(repoPath);
  const store = new AtlasStore(databasePath, { readOnly: true });
  try {
    const graphState = status.graph.status;
    return createCoverageDiagnostics({
      graphState,
      resolutionCoverage: status.graph.resolutionCoverage,
      resolutionDiagnostics: store.getGraphResolutionDiagnostics(identity.id),
    });
  } finally {
    store.close();
  }
}
