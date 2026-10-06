import type { RepositoryEvidenceState } from "../repository/repository-evidence-state.js";
import type { IndexVersionDomains } from "../facts/facts.types.js";
import type { ProjectionCount } from "../projection/known-collection.js";

export const WORKSPACE_BOUNDS = Object.freeze({
  maxRepositories: 16, maxOpenHandles: 1, defaultDetailLimit: 100, maxDetailLimit: 1000,
  maxRecordsPerRepository: 1000, maxRecords: 10000, maxPayloadBytes: 8 * 1024 * 1024,
  deadlineMs: 30000, maxConfigBytes: 64 * 1024, maxPathLength: 4096,
});
export const WORKSPACE_CONSISTENCY = "Each repository is read consistently from one pinned generation. The workspace result is not an atomic snapshot across repositories.";
export type WorkspaceMapInput = { repositories?: string[]; workspacePath?: string; limit?: number; detail?: "compact" | "full" };
export type WorkspaceDiagnostic = { repositoryId: string; code: string };
export type WorkspaceEvidenceRef = { repositoryId: string; generationId: string; ref: { path: string }; mayBeIncomplete: boolean };
export type WorkspaceReadBudget = { remainingRecords: number; remainingBytes: number; deadline: number; now: () => number; inspectedRecords: number; materializedBytes: number };
export class WorkspaceMapError extends Error {
  constructor(readonly code: "invalid_arguments" | "namespace_integrity", message: string) { super(message); }
}
export class WorkspaceReadError extends Error {
  constructor(readonly code: string, readonly availability: "unavailable" | "incompatible" | "partial" = "unavailable") { super(code); }
}
export type WorkspaceMember = {
  repositoryId: string; path: string; displayName: string; generationId: string | null;
  versions?: IndexVersionDomains; evidenceState: RepositoryEvidenceState;
  health: { availability: "available" | "unavailable" | "incompatible" | "partial"; compatibility: "compatible" | "incompatible" | "unknown"; generationAvailability: "available" | "unavailable"; diagnostics: string[] };
  queryCoverage: { complete: boolean; inspectedRecords: number };
};
export type WorkspaceMapResult = {
  workspace: { version: 1; name?: string }; state: "available" | "partial" | "unavailable";
  repositories: WorkspaceMember[]; generationVector: { repositoryId: string; generationId: string | null }[];
  evidence: { allCurrent: boolean; anyStale: boolean; anyUnknown: boolean; mayBeIncomplete: boolean };
  details: WorkspaceEvidenceRef[]; diagnostics: WorkspaceDiagnostic[];
  counts: { repositories: ProjectionCount; available: ProjectionCount; unavailable: ProjectionCount; incompatible: ProjectionCount; partial: ProjectionCount; diagnostics: ProjectionCount; details: ProjectionCount | { total: null; returned: number; omitted: null; truncated: boolean; knownInspected: ProjectionCount } };
  consistency: string; limit: number; truncated: boolean;
  work: { inspectedRecords: number; materializedBytes: number };
};
