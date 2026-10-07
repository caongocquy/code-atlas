import { stat } from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { RepositoryIdentity } from "../repository/repository-identity.js";
import { checkWorkspaceDeadline, readWorkspaceMetadata, type WorkspaceSnapshot } from "../../storage/atlas/workspace-metadata.reader.js";
import { WorkspaceMapError, WorkspaceReadError, type WorkspaceMember, type WorkspaceReadBudget, type WorkspaceEvidenceRef } from "./workspace.types.js";

export function createWorkspaceBudget(now: () => number, bounds: { maxRecords: number; maxPayloadBytes: number; deadlineMs: number }): WorkspaceReadBudget {
  return { remainingRecords: bounds.maxRecords, remainingBytes: bounds.maxPayloadBytes, deadline: now() + bounds.deadlineMs, now, inspectedRecords: 0, materializedBytes: 0 };
}

export async function coordinateWorkspaceMembers(identities: RepositoryIdentity[], budget: WorkspaceReadBudget,
  read?: (database: DatabaseSync, snapshot: WorkspaceSnapshot, identity: RepositoryIdentity, inspectedRecords: number) => void, profile: "messaging" | "packages" = "messaging") {
  const repositories: WorkspaceMember[] = [];
  const knownDetails: WorkspaceEvidenceRef[] = [];
  for (const identity of identities) {
    const before = budget.inspectedRecords;
    let member: WorkspaceMember = { repositoryId: identity.id, path: identity.rootPath, displayName: identity.displayName, generationId: null,
      evidenceState: { repositoryId: identity.id, freshness: "unknown", capabilityState: "ready", mayBeIncomplete: true, reasons: ["graph_freshness_unknown", "generation_unavailable"] },
      health: { availability: "unavailable", compatibility: "unknown", generationAvailability: "unavailable", diagnostics: [] }, queryCoverage: { complete: false, inspectedRecords: 0 } };
    try {
      checkWorkspaceDeadline(budget);
      const dbPath = path.join(identity.rootPath, ".codeatlas", "atlas.db");
      const info = await stat(dbPath);
      if (!info.isFile()) throw new WorkspaceReadError("index_unavailable");
      const snapshot = readWorkspaceMetadata(dbPath, identity, budget, read ? { profile, read: (database, snapshot, inspectedRecords) => read(database, snapshot, identity, inspectedRecords) } : undefined);
      member = { ...member, generationId: snapshot.generationId, versions: snapshot.versions,
        evidenceState: { repositoryId: identity.id, generationId: snapshot.generationId, freshness: "unknown", capabilityState: "ready", mayBeIncomplete: snapshot.mayBeIncomplete, reasons: ["graph_freshness_unknown", ...(!read && snapshot.mayBeIncomplete ? ["graph_resolution_incomplete" as const] : [])], updatedAt: snapshot.updatedAt },
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
  }
  return { repositories, knownDetails };
}
