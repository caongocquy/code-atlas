import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { pathToFileURL } from "node:url";
import type { RepositoryIdentity } from "../../core/repository/repository-identity.js";
import { CURRENT_INDEX_VERSION_DOMAINS, RELIABILITY_VERSION } from "../../core/repository/index-version.js";
import type { IndexVersionDomains } from "../../core/facts/facts.types.js";
import { WORKSPACE_BOUNDS, WorkspaceMapError, WorkspaceReadError, type WorkspaceReadBudget, type WorkspaceEvidenceRef } from "../../core/workspace/workspace.types.js";

export function checkWorkspaceDeadline(budget: WorkspaceReadBudget): void {
  if (budget.now() >= budget.deadline) throw new WorkspaceReadError("deadline_exceeded", "partial");
}
export function reserveWorkspaceRead(budget: WorkspaceReadBudget, records: number, bytes: number): void {
  checkWorkspaceDeadline(budget);
  if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > budget.remainingBytes) throw new WorkspaceReadError("payload_budget_exceeded", "partial");
  if (records > budget.remainingRecords) throw new WorkspaceReadError("record_budget_exceeded", "partial");
  budget.remainingBytes -= bytes; budget.remainingRecords -= records;
  budget.materializedBytes += bytes; budget.inspectedRecords += records;
}

export type WorkspaceSnapshot = { generationId: string; updatedAt: string; versions: IndexVersionDomains; mayBeIncomplete: boolean; complete: boolean; diagnostics: string[]; evidence: WorkspaceEvidenceRef[] };

export function readWorkspaceMetadata(databasePath: string, identity: RepositoryIdentity, budget: WorkspaceReadBudget, options?: { profile: "messaging"; read: (database: DatabaseSync, snapshot: WorkspaceSnapshot, inspectedRecords: number) => void }): WorkspaceSnapshot {
  checkWorkspaceDeadline(budget);
  // Always use a live read-only connection: immutable=1 is unsafe if a writer creates WAL after open.
  const database = new DatabaseSync(`${pathToFileURL(databasePath).href}?mode=ro`, { readOnly: true });
  let transaction = false;
  let validated: WorkspaceSnapshot | undefined;
  let records = 0;
  const row = <T>(sql: string, params: SQLInputValue[], textFields: string[]): T | undefined => {
    checkWorkspaceDeadline(budget);
    const bytes = database.prepare(`SELECT ${textFields.map(field => `coalesce(length(CAST(${field} AS BLOB)), 0)`).join(" + ") || "0"} AS bytes FROM (${sql})`).get(...params) as { bytes: number } | undefined;
    if (!bytes) return undefined;
    if (records >= WORKSPACE_BOUNDS.maxRecordsPerRepository) throw new WorkspaceReadError("record_budget_exceeded", "partial");
    reserveWorkspaceRead(budget, 1, bytes.bytes); records++;
    return database.prepare(sql).get(...params) as T;
  };
  try {
    database.exec("BEGIN;"); transaction = true;
    const schema = row<{ version: string }>("SELECT version FROM atlas_schema WHERE id = 1", [], ["version"]);
    if (schema?.version !== "3") throw new WorkspaceReadError("query_schema_unsupported", "incompatible");
    const repository = row<{ id: string; identity_key: string; root_path: string }>(
      "SELECT id, identity_key, root_path FROM repositories WHERE identity_key = ? OR id = ? LIMIT 1", [identity.identityKey, identity.id], ["id", "identity_key", "root_path"]);
    if (!repository) throw new WorkspaceReadError("repository_identity_mismatch");
    if (repository.id !== identity.id || repository.identity_key !== identity.identityKey || repository.root_path !== identity.rootPath) throw new WorkspaceMapError("namespace_integrity", "Persisted repository identity does not match its canonical namespace.");
    // This is the only active-generation read. All later queries use this captured ID.
    checkWorkspaceDeadline(budget);
    if (records >= WORKSPACE_BOUNDS.maxRecordsPerRepository || budget.remainingRecords < 1) throw new WorkspaceReadError("record_budget_exceeded", "partial");
    // Bound the pointer in SQL while selecting it only once; a separate size preflight would reread active state.
    const state = database.prepare("SELECT coalesce(length(CAST(active_generation_id AS BLOB)), 0) AS bytes, CASE WHEN length(CAST(active_generation_id AS BLOB)) <= ? THEN active_generation_id END AS active_generation_id FROM repository_index_state WHERE repository_id = ?")
      .get(budget.remainingBytes, identity.id) as { bytes: number; active_generation_id: string | null } | undefined;
    if (state) { reserveWorkspaceRead(budget, 1, state.bytes); records++; }
    if (!state) throw new WorkspaceReadError("generation_contract_unsupported", "incompatible");
    if (!state.active_generation_id) throw new WorkspaceReadError("generation_unavailable");
    const generationId = state.active_generation_id;
    const generation = row<{ repository_id: string; status: string; versions_json: string; created_at: string }>(
      "SELECT repository_id, status, versions_json, created_at FROM index_generations WHERE id = ?", [generationId], ["repository_id", "status", "versions_json", "created_at"]);
    if (!generation || generation.repository_id !== identity.id || generation.status !== "committed") throw new WorkspaceReadError("generation_invalid");
    const manifest = row<{ repository_id: string; versions_json: string; created_at: string }>("SELECT repository_id, versions_json, created_at FROM index_manifests WHERE generation_id = ?", [generationId], ["repository_id", "versions_json", "created_at"]);
    if (!manifest || manifest.repository_id !== identity.id || manifest.versions_json !== generation.versions_json || manifest.created_at !== generation.created_at) throw new WorkspaceReadError("generation_manifest_invalid");
    let versions: IndexVersionDomains;
    try { versions = JSON.parse(generation.versions_json) as IndexVersionDomains; } catch { throw new WorkspaceReadError("generation_versions_invalid", "incompatible"); }
    if (!versions || typeof versions !== "object" || Array.isArray(versions)) throw new WorkspaceReadError("generation_versions_invalid", "incompatible");
    if (!options) for (const [domain, supported] of Object.entries({ ...CURRENT_INDEX_VERSION_DOMAINS, reliabilityVersion: RELIABILITY_VERSION })) {
      if (versions[domain as keyof IndexVersionDomains] !== supported) throw new WorkspaceReadError("semantic_domain_unsupported", "incompatible");
    }
    // Expose only supported semantic metadata, never arbitrary JSON fields from an index.
    versions = options ? Object.fromEntries(Object.keys({ ...CURRENT_INDEX_VERSION_DOMAINS, reliabilityVersion: RELIABILITY_VERSION }).map(key => [key, versions[key as keyof IndexVersionDomains]])) as IndexVersionDomains : { ...CURRENT_INDEX_VERSION_DOMAINS, reliabilityVersion: RELIABILITY_VERSION };
    validated = { generationId, updatedAt: generation.created_at, versions, mayBeIncomplete: true, complete: false, diagnostics: [], evidence: [] };
    if (options) {
      options.read(database, validated, records);
      checkWorkspaceDeadline(budget);
      database.exec("COMMIT;"); transaction = false;
      return { ...validated, complete: true };
    }
    const remaining = Math.min(WORKSPACE_BOUNDS.maxRecordsPerRepository - records, budget.remainingRecords);
    const scope = [identity.id, generationId];
    const size = database.prepare(`SELECT count(*) AS count, coalesce(sum(length(CAST(file_path AS BLOB))), 0) AS bytes FROM (SELECT file_path FROM generation_graph_resolution_files WHERE repository_id = ? AND generation_id = ? ORDER BY file_path LIMIT ?)`).get(...scope, remaining + 1) as { count: number; bytes: number };
    const diagnostics: string[] = [];
    let evidence: WorkspaceEvidenceRef[] = [];
    if (size.count > remaining) diagnostics.push("record_budget_exceeded");
    else if (size.bytes > budget.remainingBytes) diagnostics.push("payload_budget_exceeded");
    else {
      reserveWorkspaceRead(budget, size.count, size.bytes);
      const coverage = database.prepare("SELECT file_path, may_be_incomplete FROM generation_graph_resolution_files WHERE repository_id = ? AND generation_id = ? ORDER BY file_path LIMIT ?").all(...scope, remaining) as { file_path: string; may_be_incomplete: number }[];
      evidence = coverage.map(item => ({ repositoryId: identity.id, generationId, ref: { path: item.file_path }, mayBeIncomplete: item.may_be_incomplete !== 0 }));
    }
    checkWorkspaceDeadline(budget);
    database.exec("COMMIT;"); transaction = false;
    return { generationId, updatedAt: generation.created_at, versions, mayBeIncomplete: diagnostics.length > 0 || evidence.some(item => item.mayBeIncomplete), complete: diagnostics.length === 0, diagnostics, evidence };
  } catch (error) {
    if (validated && error instanceof WorkspaceReadError && error.availability === "partial") {
      return { ...validated, diagnostics: [error.code] };
    }
    if (error instanceof WorkspaceReadError || error instanceof WorkspaceMapError) throw error;
    const message = error instanceof Error ? error.message : "";
    if (/no such (table|column)/i.test(message)) throw new WorkspaceReadError("generation_contract_unsupported", "incompatible");
    throw error;
  } finally {
    if (transaction) { try { database.exec("ROLLBACK;"); } catch { /* Preserve the original read failure. */ } }
    database.close();
  }
}
