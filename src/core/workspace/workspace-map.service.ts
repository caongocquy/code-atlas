import { resolveWorkspaceMembership } from "./workspace-membership.js";
import { coordinateWorkspaceMembers } from "./workspace-coordinator.js";
import { performance } from "node:perf_hooks";
import { exactProjectionCount } from "../projection/known-collection.js";
import { WORKSPACE_BOUNDS, WORKSPACE_CONSISTENCY, WorkspaceMapError, type WorkspaceMember, type WorkspaceMapInput, type WorkspaceMapResult, type WorkspaceReadBudget, type WorkspaceDiagnostic } from "./workspace.types.js";
export { WorkspaceMapError } from "./workspace.types.js";

export async function queryWorkspaceMap(input: WorkspaceMapInput, options: { cwd?: string; now?: () => number } = {}): Promise<WorkspaceMapResult> {
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(key => !["repositories", "workspacePath", "limit", "detail"].includes(key))) throw new WorkspaceMapError("invalid_arguments", "Invalid workspace object or unsupported field.");
  const limit = input.limit ?? WORKSPACE_BOUNDS.defaultDetailLimit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKSPACE_BOUNDS.maxDetailLimit || (input.detail !== undefined && !["compact", "full"].includes(input.detail))) throw new WorkspaceMapError("invalid_arguments", "Invalid workspace projection limit or detail.");
  const now = options.now ?? (() => performance.now());
  const budget: WorkspaceReadBudget = { remainingRecords: WORKSPACE_BOUNDS.maxRecords, remainingBytes: WORKSPACE_BOUNDS.maxPayloadBytes, deadline: now() + WORKSPACE_BOUNDS.deadlineMs, now, inspectedRecords: 0, materializedBytes: 0 };
  const selected = await resolveWorkspaceMembership(input, options.cwd ?? process.cwd(), budget);
  const { repositories, knownDetails } = await coordinateWorkspaceMembers(selected.identities, budget);
  const knownDiagnostics: WorkspaceDiagnostic[] = repositories.flatMap(member => member.health.diagnostics.map(code => ({ repositoryId: member.repositoryId, code })));
  knownDiagnostics.sort((a, b) => a.repositoryId < b.repositoryId ? -1 : a.repositoryId > b.repositoryId ? 1 : a.code < b.code ? -1 : a.code > b.code ? 1 : 0);
  const diagnostics = knownDiagnostics.slice(0, limit);
  const details = input.detail === "full" ? knownDetails.slice(0, limit - diagnostics.length) : [];
  const count = (availability: WorkspaceMember["health"]["availability"]) => { const n = repositories.filter(member => member.health.availability === availability).length; return exactProjectionCount(n, n); };
  const complete = repositories.every(member => member.queryCoverage.complete);
  const truncated = knownDiagnostics.length > diagnostics.length || (input.detail === "full" && knownDetails.length > details.length);
  const available = repositories.filter(member => member.generationId !== null).length;
  return { workspace: selected.workspace, state: available === 0 ? "unavailable" : complete ? "available" : "partial", repositories,
    generationVector: repositories.map(member => ({ repositoryId: member.repositoryId, generationId: member.generationId })),
    evidence: { allCurrent: false, anyStale: false, anyUnknown: true, mayBeIncomplete: repositories.some(member => member.evidenceState.mayBeIncomplete) || !complete || truncated },
    details, diagnostics, counts: { repositories: exactProjectionCount(repositories.length, repositories.length), available: count("available"), unavailable: count("unavailable"), incompatible: count("incompatible"), partial: count("partial"), diagnostics: exactProjectionCount(knownDiagnostics.length, diagnostics.length),
      details: complete ? exactProjectionCount(knownDetails.length, details.length) : { total: null, returned: details.length, omitted: null, truncated: knownDetails.length > details.length, knownInspected: exactProjectionCount(knownDetails.length, details.length) } },
    consistency: WORKSPACE_CONSISTENCY, limit, truncated, work: { inspectedRecords: budget.inspectedRecords, materializedBytes: budget.materializedBytes } };
}
