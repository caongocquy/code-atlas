import type { FrameworkSnapshot } from "./framework.types.js";
import { aggregateReliability } from "../reliability/reliability-aggregator.js";
import { canonicalReliabilityScope } from "../reliability/reliability-identity.js";
import type { ReliabilityContribution, ReliabilityProjection, ReliabilityScopeInput } from "../reliability/reliability.types.js";

export interface FrameworkStatus {
  status: "ready" | "stale" | "not_indexed";
  detections: FrameworkSnapshot["detections"];
  coverage: FrameworkSnapshot["coverage"];
  diagnostics: FrameworkSnapshot["diagnostics"];
  mayBeIncomplete: boolean;
  authoritativeNegativeResults: boolean;
  reliability?: ReliabilityProjection;
}

export function summarizeFrameworkCoverage(snapshot: FrameworkSnapshot | undefined, expectedVersion: string, contributions: readonly ReliabilityContribution[] = [], scopeInput: ReliabilityScopeInput = { capability: "framework_repository" }): FrameworkStatus {
  if (!snapshot) return { status: "not_indexed", detections: [], coverage: [], diagnostics: [], mayBeIncomplete: true, authoritativeNegativeResults: false };
  const stale = snapshot.frameworkResolutionVersion !== expectedVersion;
  const incomplete = !snapshot.complete || snapshot.config.some((item) => !item.complete) || snapshot.detections.some((item) => !item.complete || (item.configured && !item.observed)) || snapshot.detections.some((detection) => detection.observed && (detection.capabilities.length === 0 ? !snapshot.coverage.some((item) => item.framework === detection.framework && item.applicable > 0) : detection.capabilities.some((capability) => !snapshot.coverage.some((item) => item.framework === detection.framework && item.capability === capability && item.applicable > 0)))) || snapshot.diagnostics.length > 0 || snapshot.coverage.some((item) => item.applicable > 0 && (item.supported < item.applicable || item.attempted < item.applicable || item.resolved + item.ambiguous + item.unknown + item.unsupported + item.budgetExhausted < item.attempted || item.attempted === 0 || (item.resolved === 0 && item.ambiguous === 0 && item.unknown === 0 && item.unsupported === 0 && item.budgetExhausted === 0) || item.unknown > 0 || item.ambiguous > 0 || item.unsupported > 0 || item.budgetExhausted > 0));
  const reliability = contributions.length > 0 ? aggregateReliability(contributions, canonicalReliabilityScope(scopeInput)) : undefined;
  const mayBeIncomplete = stale || incomplete || reliability !== undefined && (!reliability.complete || reliability.stale);
  return { status: stale ? "stale" : "ready", detections: snapshot.detections, coverage: snapshot.coverage, diagnostics: snapshot.diagnostics, mayBeIncomplete, authoritativeNegativeResults: !mayBeIncomplete && (reliability === undefined || reliability.authoritativeNegative), ...(reliability ? { reliability } : {}) };
}
