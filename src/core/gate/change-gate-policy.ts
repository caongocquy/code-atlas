import { createHash } from "node:crypto";
import type { GraphDeltaContext } from "../change/graph-delta.service.js";
import { loadCodeAtlasConfigSnapshots, type CodeAtlasConfigSource } from "../config/codeatlas-config-snapshot.js";
import type { ArchitectureCause, ArchitectureFindingKind } from "../architecture/architecture-drift.types.js";
import type { ArchitectureSeverity } from "../architecture/architecture-policy.js";
import type { CoverageGapKind } from "../diagnostics/coverage-diagnostics.types.js";
import type { ChangeGatePolicy, ChangeGatePolicyPair, ChangeGatePolicySnapshot } from "./change-gate.types.js";
import { parseCodeAtlasRepositoryConfig } from "../config/codeatlas-config.js";

const gateGapKinds: CoverageGapKind[] = ["dynamic_dispatch", "ambiguous_target", "missing_caller_context", "broken_internal_import", "parser_error", "unsupported_construct", "unmapped_change_range", "missing_baseline", "binary_change", "truncated_analysis", "ambiguous_architecture_membership"];
const findingKinds: ArchitectureFindingKind[] = ["forbidden_dependency", "dependency_cycle", "unclassified_dependency"];
const causes: ArchitectureCause[] = ["code_change", "policy_change", "both"];
const severities: ArchitectureSeverity[] = ["low", "medium", "high"];

export class ChangeGateConfigError extends Error {}
const isObject = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function object(value: unknown, label: string): Record<string, unknown> { if (!isObject(value)) throw new ChangeGateConfigError(`${label} must be an object.`); return value; }
function known(value: Record<string, unknown>, allowed: readonly string[], label: string): void { for (const key of Object.keys(value)) if (!allowed.includes(key)) throw new ChangeGateConfigError(`${label}.${key} is not supported.`); }
function oneOf<T extends string>(value: unknown, values: readonly T[], label: string): T { if (typeof value !== "string" || !values.includes(value as T)) throw new ChangeGateConfigError(`${label} is invalid.`); return value as T; }
function setOf<T extends string>(value: unknown, values: readonly T[], label: string): T[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string")) {
    throw new ChangeGateConfigError(`${label} must be a non-empty supported value array.`);
  }
  const unsupported = value.find((item) => !values.includes(item as T));
  if (unsupported !== undefined) throw new ChangeGateConfigError(`${label} contains unsupported value: ${String(unsupported)}.`);
  if (new Set(value).size !== value.length) throw new ChangeGateConfigError(`${label} contains duplicates.`);
  return [...value] as T[];
}

export function parseChangeGatePolicy(raw: unknown): ChangeGatePolicy | undefined {
  let root: ReturnType<typeof parseCodeAtlasRepositoryConfig>;
  try {
    root = parseCodeAtlasRepositoryConfig(raw);
  } catch (error) {
    throw new ChangeGateConfigError(error instanceof Error ? error.message : String(error));
  }
  if (root.gate === undefined) return undefined;
  const gate = root.gate;
  known(gate, ["risk", "tests", "diagnostics", "architecture"], "gate");
  const policy: ChangeGatePolicy = {};
  let effective = false;
  if (gate.risk !== undefined) {
    const value = object(gate.risk, "gate.risk"); known(value, ["maxAllowed", "allowUnknown"], "gate.risk");
    const risk: NonNullable<ChangeGatePolicy["risk"]> = {};
    if (value.maxAllowed !== undefined) { risk.maxAllowed = oneOf(value.maxAllowed, severities, "gate.risk.maxAllowed"); effective = true; }
    if (value.allowUnknown !== undefined) { if (typeof value.allowUnknown !== "boolean") throw new ChangeGateConfigError("gate.risk.allowUnknown must be boolean."); risk.allowUnknown = value.allowUnknown; effective = true; }
    policy.risk = risk;
  }
  if (gate.tests !== undefined) {
    const value = object(gate.tests, "gate.tests"); known(value, ["maxUncoveredAffectedSymbols", "minStructuralTestEvidenceRatio"], "gate.tests");
    const tests: NonNullable<ChangeGatePolicy["tests"]> = {};
    if (value.maxUncoveredAffectedSymbols !== undefined) { if (!Number.isInteger(value.maxUncoveredAffectedSymbols) || (value.maxUncoveredAffectedSymbols as number) < 0) throw new ChangeGateConfigError("gate.tests.maxUncoveredAffectedSymbols must be a non-negative integer."); tests.maxUncoveredAffectedSymbols = value.maxUncoveredAffectedSymbols as number; effective = true; }
    if (value.minStructuralTestEvidenceRatio !== undefined) { if (typeof value.minStructuralTestEvidenceRatio !== "number" || !Number.isFinite(value.minStructuralTestEvidenceRatio) || value.minStructuralTestEvidenceRatio < 0 || value.minStructuralTestEvidenceRatio > 1) throw new ChangeGateConfigError("gate.tests.minStructuralTestEvidenceRatio must be between 0 and 1."); tests.minStructuralTestEvidenceRatio = value.minStructuralTestEvidenceRatio; effective = true; }
    policy.tests = tests;
  }
  if (gate.diagnostics !== undefined) {
    const value = object(gate.diagnostics, "gate.diagnostics"); known(value, ["requireAuthoritativeNegativeResults", "forbidGapKinds"], "gate.diagnostics");
    const diagnostics: NonNullable<ChangeGatePolicy["diagnostics"]> = {};
    if (value.requireAuthoritativeNegativeResults !== undefined) { if (typeof value.requireAuthoritativeNegativeResults !== "boolean") throw new ChangeGateConfigError("gate.diagnostics.requireAuthoritativeNegativeResults must be boolean."); diagnostics.requireAuthoritativeNegativeResults = value.requireAuthoritativeNegativeResults; effective ||= value.requireAuthoritativeNegativeResults === true; }
    if (value.forbidGapKinds !== undefined) { diagnostics.forbidGapKinds = setOf(value.forbidGapKinds, gateGapKinds, "gate.diagnostics.forbidGapKinds"); effective = true; }
    policy.diagnostics = diagnostics;
  }
  if (gate.architecture !== undefined) {
    const value = object(gate.architecture, "gate.architecture"); known(value, ["failOnSeverityAtLeast", "causes", "kinds"], "gate.architecture");
    const architecture: NonNullable<ChangeGatePolicy["architecture"]> = {};
    if (value.failOnSeverityAtLeast !== undefined) { architecture.failOnSeverityAtLeast = oneOf(value.failOnSeverityAtLeast, severities, "gate.architecture.failOnSeverityAtLeast"); effective = true; }
    if (value.causes !== undefined) { architecture.causes = setOf(value.causes, causes, "gate.architecture.causes"); }
    if (value.kinds !== undefined) { architecture.kinds = setOf(value.kinds, findingKinds, "gate.architecture.kinds"); }
    policy.architecture = architecture;
  }
  if (!effective) throw new ChangeGateConfigError("gate must contain at least one effective check.");
  return policy;
}

function stable(value: unknown): string { if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`; if (isObject(value)) return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`; return JSON.stringify(value); }
export function changeGateSemanticHash(policy: ChangeGatePolicy): string {
  const value = {
    risk: policy.risk,
    tests: policy.tests,
    diagnostics: policy.diagnostics && { ...policy.diagnostics, forbidGapKinds: [...(policy.diagnostics.forbidGapKinds ?? [])].sort() },
    architecture: policy.architecture && { ...policy.architecture, causes: [...(policy.architecture.causes ?? ["code_change", "both"])].sort(), kinds: [...(policy.architecture.kinds ?? findingKinds)].sort() },
  };
  return createHash("sha256").update(stable(value)).digest("hex");
}

function snapshot(config: CodeAtlasConfigSource, side: "baseline" | "target"): ChangeGatePolicySnapshot {
  if (!config.content) return { configured: false, source: config.source };
  try {
    const policy = parseChangeGatePolicy(JSON.parse(config.content.toString("utf8")));
    return policy ? { configured: true, source: config.source, policy, semanticHash: changeGateSemanticHash(policy) } : { configured: false, source: config.source };
  } catch (error) {
    const revision = config.source.revision ? `:${config.source.revision}` : "";
    throw new ChangeGateConfigError(`Invalid ${side} gate policy at ${config.source.kind}${revision}:${config.source.path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function loadChangeGatePolicySnapshots(repoPath: string, context: GraphDeltaContext, explicitPath?: string): Promise<ChangeGatePolicyPair> {
  const configs = await loadCodeAtlasConfigSnapshots(repoPath, context, explicitPath);
  const baseline = snapshot(configs.baseline, "baseline");
  const target = snapshot(configs.target, "target");
  return { path: configs.path, baseline, target, fileChanged: configs.fileChanged, semanticChanged: baseline.semanticHash !== target.semanticHash, changeKind: configs.changeKind };
}
