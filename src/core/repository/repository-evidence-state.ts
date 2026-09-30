import type { RepositoryStatus } from "./repository-status.service.js";

export type EvidenceFreshness = "current" | "stale" | "unknown";

export type EvidenceStateReason =
  | "graph_stale"
  | "graph_freshness_unknown"
  | "generation_unavailable"
  | "graph_resolution_incomplete"
  | "framework_incomplete";

export type RepositoryEvidenceState = {
  repositoryId: string;
  generationId?: string;
  freshness: EvidenceFreshness;
  capabilityState: "ready" | "stale";
  mayBeIncomplete: boolean;
  reasons: EvidenceStateReason[];
  updatedAt?: string;
};

export function buildRepositoryEvidenceState(
  repositoryId: string,
  generationId: string | undefined,
  graphStatus: Pick<RepositoryStatus["graph"], "status" | "resolutionCoverage" | "updatedAt">,
  frameworkMayBeIncomplete: boolean,
): RepositoryEvidenceState {
  const freshness = graphStatus.status === "ready" ? "current" : graphStatus.status === "stale" ? "stale" : "unknown";
  const reasons: EvidenceStateReason[] = [];
  if (freshness === "stale") reasons.push("graph_stale");
  if (freshness === "unknown") reasons.push("graph_freshness_unknown");
  if (!generationId) reasons.push("generation_unavailable");
  if (graphStatus.resolutionCoverage.mayBeIncomplete) reasons.push("graph_resolution_incomplete");
  if (frameworkMayBeIncomplete) reasons.push("framework_incomplete");
  return {
    repositoryId,
    ...(generationId ? { generationId } : {}),
    freshness,
    capabilityState: graphStatus.status === "stale" ? "stale" : "ready",
    mayBeIncomplete: graphStatus.resolutionCoverage.mayBeIncomplete || frameworkMayBeIncomplete,
    reasons,
    ...(graphStatus.updatedAt ? { updatedAt: graphStatus.updatedAt } : {}),
  };
}
