import { open, stat } from "node:fs/promises";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { getRepositoryIdentity } from "../repository/repository-identity.js";
import { exactProjectionCount } from "../projection/known-collection.js";
import { checkWorkspaceDeadline, readWorkspaceMetadata, reserveWorkspaceRead } from "../../storage/atlas/workspace-metadata.reader.js";
import { WORKSPACE_BOUNDS, WORKSPACE_CONSISTENCY, WorkspaceMapError, WorkspaceReadError, type WorkspaceMapInput, type WorkspaceMapResult, type WorkspaceMember, type WorkspaceReadBudget, type WorkspaceEvidenceRef, type WorkspaceDiagnostic } from "./workspace.types.js";
export { WorkspaceMapError } from "./workspace.types.js";

function object(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key))) throw new WorkspaceMapError("invalid_arguments", "Invalid workspace object or unsupported field.");
  return raw as Record<string, unknown>;
}
function text(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > WORKSPACE_BOUNDS.maxPathLength || raw.includes("\0")) throw new WorkspaceMapError("invalid_arguments", "Workspace paths must be non-empty bounded strings.");
  return raw;
}
function paths(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > WORKSPACE_BOUNDS.maxRepositories) throw new WorkspaceMapError("invalid_arguments", "Select between 1 and 16 repositories.");
  return raw.map(text);
}
async function members(input: WorkspaceMapInput, cwd: string, budget: WorkspaceReadBudget) {
  object(input, ["repositories", "workspacePath", "limit", "detail"]);
  if ((input.repositories !== undefined) === (input.workspacePath !== undefined)) throw new WorkspaceMapError("invalid_arguments", "Choose exactly one of repositories or workspacePath.");
  let repositories: string[];
  let name: string | undefined;
  let base = cwd;
  if (input.workspacePath !== undefined) {
    const configPath = path.resolve(cwd, text(input.workspacePath));
    base = path.dirname(configPath);
    let raw: unknown;
    try {
      const handle = await open(configPath, "r");
      try {
        const size = (await handle.stat()).size;
        if (size > WORKSPACE_BOUNDS.maxConfigBytes || size > budget.remainingBytes) throw new Error("Workspace config is too large.");
        const buffer = Buffer.alloc(Math.min(WORKSPACE_BOUNDS.maxConfigBytes, budget.remainingBytes) + 1);
        let length = 0;
        while (length < buffer.length) {
          checkWorkspaceDeadline(budget);
          const read = await handle.read(buffer, length, buffer.length - length, null);
          if (read.bytesRead === 0) break;
          length += read.bytesRead;
        }
        if (length > WORKSPACE_BOUNDS.maxConfigBytes) throw new Error("Workspace config is too large.");
        reserveWorkspaceRead(budget, 0, length);
        raw = JSON.parse(buffer.subarray(0, length).toString("utf8"));
      } finally { await handle.close(); }
    } catch (error) {
      throw new WorkspaceMapError("invalid_arguments", `Unable to read workspace config: ${error instanceof Error ? error.message : String(error)}`);
    }
    const config = object(raw, ["version", "name", "repositories"]);
    if (config.version !== 1) throw new WorkspaceMapError("invalid_arguments", "Workspace config version must be 1.");
    if (config.name !== undefined) { name = text(config.name); if (name.length > 256) throw new WorkspaceMapError("invalid_arguments", "Workspace name is too long."); }
    if (!Array.isArray(config.repositories)) throw new WorkspaceMapError("invalid_arguments", "Workspace repositories must be an array.");
    repositories = paths(config.repositories.map(member => text(object(member, ["path"]).path)));
  } else repositories = paths(input.repositories);
  const identities = repositories.map(repo => getRepositoryIdentity(path.resolve(base, repo)));
  if (new Set(identities.map(identity => identity.rootPath)).size !== identities.length || new Set(identities.map(identity => identity.id)).size !== identities.length) throw new WorkspaceMapError("invalid_arguments", "Duplicate canonical repository path or namespace.");
  identities.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { identities, workspace: { version: 1 as const, ...(name !== undefined ? { name } : {}) } };
}

export async function queryWorkspaceMap(input: WorkspaceMapInput, options: { cwd?: string; now?: () => number } = {}): Promise<WorkspaceMapResult> {
  object(input, ["repositories", "workspacePath", "limit", "detail"]);
  const limit = input.limit ?? WORKSPACE_BOUNDS.defaultDetailLimit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKSPACE_BOUNDS.maxDetailLimit || (input.detail !== undefined && !["compact", "full"].includes(input.detail))) throw new WorkspaceMapError("invalid_arguments", "Invalid workspace projection limit or detail.");
  const now = options.now ?? (() => performance.now());
  const budget: WorkspaceReadBudget = { remainingRecords: WORKSPACE_BOUNDS.maxRecords, remainingBytes: WORKSPACE_BOUNDS.maxPayloadBytes, deadline: now() + WORKSPACE_BOUNDS.deadlineMs, now, inspectedRecords: 0, materializedBytes: 0 };
  const selected = await members(input, options.cwd ?? process.cwd(), budget);
  const repositories: WorkspaceMember[] = [];
  const knownDetails: WorkspaceEvidenceRef[] = [];
  const knownDiagnostics: WorkspaceDiagnostic[] = [];
  for (const identity of selected.identities) {
    const before = budget.inspectedRecords;
    let member: WorkspaceMember = { repositoryId: identity.id, path: identity.rootPath, displayName: identity.displayName, generationId: null,
      evidenceState: { repositoryId: identity.id, freshness: "unknown", capabilityState: "ready", mayBeIncomplete: true, reasons: ["graph_freshness_unknown", "generation_unavailable"] },
      health: { availability: "unavailable", compatibility: "unknown", generationAvailability: "unavailable", diagnostics: [] }, queryCoverage: { complete: false, inspectedRecords: 0 } };
    try {
      checkWorkspaceDeadline(budget);
      const dbPath = path.join(identity.rootPath, ".codeatlas", "atlas.db");
      const info = await stat(dbPath);
      if (!info.isFile()) throw new WorkspaceReadError("index_unavailable");
      const snapshot = readWorkspaceMetadata(dbPath, identity, budget);
      member = { ...member, generationId: snapshot.generationId, versions: snapshot.versions,
        evidenceState: { repositoryId: identity.id, generationId: snapshot.generationId, freshness: "unknown", capabilityState: "ready", mayBeIncomplete: snapshot.mayBeIncomplete, reasons: ["graph_freshness_unknown", ...(snapshot.mayBeIncomplete ? ["graph_resolution_incomplete" as const] : [])], updatedAt: snapshot.updatedAt },
        health: { availability: snapshot.complete ? "available" : "partial", compatibility: "compatible", generationAvailability: "available", diagnostics: snapshot.diagnostics }, queryCoverage: { complete: snapshot.complete, inspectedRecords: budget.inspectedRecords - before } };
      knownDetails.push(...snapshot.evidence);
    } catch (error) {
      if (error instanceof WorkspaceMapError) throw error;
      const errno = (error as NodeJS.ErrnoException).code;
      const code = error instanceof WorkspaceReadError ? error.code : errno === "ENOENT" ? "index_missing" : errno === "EACCES" || errno === "EPERM" ? "index_inaccessible" : "index_read_failed";
      const availability = error instanceof WorkspaceReadError ? error.availability : "unavailable";
      member.health = { availability, compatibility: availability === "incompatible" ? "incompatible" : "unknown", generationAvailability: "unavailable", diagnostics: [code] };
      member.queryCoverage.inspectedRecords = budget.inspectedRecords - before;
    }
    repositories.push(member);
    knownDiagnostics.push(...member.health.diagnostics.map(code => ({ repositoryId: identity.id, code })));
  }
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
