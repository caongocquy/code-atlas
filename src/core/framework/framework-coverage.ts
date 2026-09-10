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
  const incomplete = !snapshot.complete || snapshot.config.some((item) => !item.complete) || snapshot.detections.some((item) => !item.complete) || snapshot.diagnostics.length > 0 || snapshot.coverage.some((item) => item.attempted === 0 || item.unknown > 0 || item.ambiguous > 0 || item.unsupported > 0 || item.budgetExhausted > 0);
  return { status: stale ? "stale" : "ready", detections: snapshot.detections, coverage: snapshot.coverage, diagnostics: snapshot.diagnostics, mayBeIncomplete: stale || incomplete, authoritativeNegativeResults: !stale && !incomplete };
}
