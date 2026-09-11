import type { FrameworkSnapshot } from "./framework.types.js";

export interface FrameworkStatus {
  status: "ready" | "stale" | "not_indexed";
  detections: FrameworkSnapshot["detections"];
  coverage: FrameworkSnapshot["coverage"];
  diagnostics: FrameworkSnapshot["diagnostics"];
  mayBeIncomplete: boolean;
  authoritativeNegativeResults: boolean;
}

export function summarizeFrameworkCoverage(snapshot: FrameworkSnapshot | undefined, expectedVersion: string): FrameworkStatus {
  if (!snapshot) return { status: "not_indexed", detections: [], coverage: [], diagnostics: [], mayBeIncomplete: true, authoritativeNegativeResults: false };
  const stale = snapshot.frameworkResolutionVersion !== expectedVersion;
  const incomplete = !snapshot.complete || snapshot.config.some((item) => !item.complete) || snapshot.detections.some((item) => !item.complete || (item.configured && !item.observed)) || snapshot.detections.some((detection) => detection.observed && (detection.capabilities.length === 0 ? !snapshot.coverage.some((item) => item.framework === detection.framework && item.applicable > 0) : detection.capabilities.some((capability) => !snapshot.coverage.some((item) => item.framework === detection.framework && item.capability === capability && item.applicable > 0)))) || snapshot.diagnostics.length > 0 || snapshot.coverage.some((item) => item.applicable > 0 && (item.supported < item.applicable || item.attempted < item.applicable || item.resolved + item.ambiguous + item.unknown + item.unsupported + item.budgetExhausted < item.attempted || item.attempted === 0 || (item.resolved === 0 && item.ambiguous === 0 && item.unknown === 0 && item.unsupported === 0 && item.budgetExhausted === 0) || item.unknown > 0 || item.ambiguous > 0 || item.unsupported > 0 || item.budgetExhausted > 0));
  return { status: stale ? "stale" : "ready", detections: snapshot.detections, coverage: snapshot.coverage, diagnostics: snapshot.diagnostics, mayBeIncomplete: stale || incomplete, authoritativeNegativeResults: !stale && !incomplete };
}
