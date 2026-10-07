import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import { INDEX_SCHEMA_VERSION } from "../../core/repository/index-version.js";
import { WORKSPACE_BOUNDS, WorkspaceReadError, type WorkspaceReadBudget } from "../../core/workspace/workspace.types.js";
import { DEPENDENCY_KINDS, isPackageName, isRegistrySpec, packageRoleCoverage, type PackageRoleCoverage, type WorkspacePackageInputs, type WorkspacePackageLinksInput, type PackageEvidenceRef } from "../../core/workspace/workspace-package-links.types.js";
import { checkWorkspaceDeadline, reserveWorkspaceRead, type WorkspaceSnapshot } from "./workspace-metadata.reader.js";

// C1 deliberately accepts only the closed acquisition contract, independently of future current versions.
const CERTIFIED_FRAMEWORK_VERSION = "1.7.0";
const MAX_STORED_CONFIG_BYTES = 2 * 1024 * 1024;
const MAX_ROOT_BYTES = 256 * 1024;
type Size = { count: number; bytes: number };
type Root = { inputKey: string; nameType: string | null; name: string | null; versionType: string | null; version: string | null };
export function readWorkspacePackages(database: DatabaseSync, snapshot: WorkspaceSnapshot, repositoryId: string,
  budget: WorkspaceReadBudget, inspectedRecords: number, input: WorkspacePackageLinksInput): WorkspacePackageInputs {
  const packageRequested = !input.targetRepositoryId || input.targetRepositoryId === repositoryId;
  const dependencyRequested = !input.sourceRepositoryId || input.sourceRepositoryId === repositoryId;
  const data: WorkspacePackageInputs = { packageDeclarationCoverage: packageRoleCoverage(packageRequested),
    dependencyDeclarationCoverage: packageRoleCoverage(dependencyRequested), dependencies: [], diagnostics: [] };
  if (!packageRequested && !dependencyRequested) return data;
  let records = inspectedRecords;
  const reserve = (count: number, bytes = 0) => {
    if (count > WORKSPACE_BOUNDS.maxRecordsPerRepository - records) throw new WorkspaceReadError("record_budget_exceeded", "partial");
    reserveWorkspaceRead(budget, count, bytes); records += count;
  };
  const fail = (coverage: PackageRoleCoverage, role: "package" | "dependency", code: string, unsupported = true) => {
    if (coverage.status === "not_requested") return;
    coverage.status = unsupported ? "unsupported" : "unavailable"; coverage.scanComplete = false; coverage.reasons.push(code);
    // Diagnostic work is charged too; a depleted budget still retains the bounded coverage reason.
    try { reserve(1, Buffer.byteLength(code)); data.diagnostics.push({ repositoryId, generationId: snapshot.generationId, role, code }); } catch { /* Coverage remains incomplete. */ }
  };
  const scope: SQLInputValue[] = [repositoryId, snapshot.generationId];
  const state = "FROM generation_framework_state WHERE repository_id = ? AND generation_id = ?";
  try {
    if (snapshot.versions.schemaVersion !== INDEX_SCHEMA_VERSION || snapshot.versions.frameworkResolutionVersion !== CERTIFIED_FRAMEWORK_VERSION)
      throw new WorkspaceReadError("package_semantic_domain_unsupported", "incompatible");
    checkWorkspaceDeadline(budget);
    const binding = database.prepare(`SELECT count(*) AS count, coalesce(sum(length(CAST(relative_path AS BLOB)) + length(CAST(content_hash AS BLOB)) + length(CAST(fact_blob_key AS BLOB))), 0) AS bytes
      FROM (SELECT relative_path, content_hash, fact_blob_key FROM file_fact_bindings WHERE repository_id = ? AND generation_id = ?
      AND language IN ('javascript','typescript','tsx') ORDER BY relative_path LIMIT 1)`).get(...scope) as Size;
    reserve(binding.count, binding.bytes);
    if (!binding.count) throw new WorkspaceReadError("js_ts_evidence_missing", "incompatible");
    const size = database.prepare(`SELECT length(CAST(config_json AS BLOB)) AS bytes,
      framework_resolution_version = ? AS certified ${state}`).get(CERTIFIED_FRAMEWORK_VERSION, ...scope) as { bytes: number; certified: number } | undefined;
    if (!size) throw new WorkspaceReadError("package_config_unavailable");
    if (!size.certified) throw new WorkspaceReadError("package_semantic_domain_unsupported", "incompatible");
    if (size.bytes > MAX_STORED_CONFIG_BYTES) throw new WorkspaceReadError("payload_budget_exceeded", "partial");
    reserve(1, size.bytes); // Before SQLite JSON traversal or any JS hydration.
    const shape = database.prepare(`SELECT CASE WHEN json_valid(config_json) THEN json_type(config_json) END AS type ${state}`).get(...scope) as { type: string | null };
    if (shape.type !== "array") throw new WorkspaceReadError("package_config_invalid", "incompatible");
    const remaining = Math.min(WORKSPACE_BOUNDS.maxRecordsPerRepository - records, budget.remainingRecords);
    const count = database.prepare(`SELECT count(*) AS count FROM (SELECT 1 FROM generation_framework_state s, json_each(s.config_json)
      WHERE s.repository_id = ? AND s.generation_id = ? LIMIT ?)`).get(...scope, remaining + 1) as { count: number };
    reserve(count.count);
    // Match path first, so malformed root scope/kind cannot masquerade as absent evidence.
    const rootSql = `SELECT j.value AS record FROM generation_framework_state s, json_each(s.config_json) j
      WHERE s.repository_id = ? AND s.generation_id = ? AND j.type = 'object'
      AND json_extract(j.value, '$.relativePath') = 'package.json'`;
    const roots = database.prepare(`SELECT count(*) AS count, coalesce(sum(length(CAST(record AS BLOB))), 0) AS bytes FROM (${rootSql})`).get(...scope) as Size;
    if (!roots.count) throw new WorkspaceReadError("root_package_evidence_missing");
    if (roots.count !== 1) throw new WorkspaceReadError("root_package_conflict", "incompatible");
    if (roots.bytes > MAX_ROOT_BYTES) throw new WorkspaceReadError("payload_budget_exceeded", "partial");
    const valid = database.prepare(`SELECT json_extract(record, '$.kind') = 'package'
      AND json_extract(record, '$.scope') = '' AND json_type(record, '$.complete') = 'true'
      AND json_type(record, '$.values') = 'object' AND json_type(record, '$.inputKey') = 'text'
      AND length(json_extract(record, '$.inputKey')) <= 4096
      AND (SELECT count(*) FROM json_each(record)) = 6
      AND NOT EXISTS(SELECT 1 FROM json_each(record) WHERE key NOT IN ('relativePath','scope','inputKey','kind','values','complete')) AS valid
      FROM (${rootSql})`).get(...scope) as { valid: number | null };
    if (valid.valid !== 1) throw new WorkspaceReadError("root_package_contract_invalid", "incompatible");
    const rootFields = `SELECT json_extract(record, '$.inputKey') AS inputKey,
      json_type(record, '$.values.name') AS nameType,
      CASE WHEN json_type(record, '$.values.name') = 'text' THEN json_extract(record, '$.values.name') END AS name,
      json_type(record, '$.values.version') AS versionType,
      CASE WHEN json_type(record, '$.values.version') = 'text' THEN json_extract(record, '$.values.version') END AS version FROM (${rootSql})`;
    const fieldsSize = database.prepare(`SELECT coalesce(length(CAST(inputKey AS BLOB)),0) + coalesce(length(CAST(name AS BLOB)),0)
      + coalesce(length(CAST(version AS BLOB)),0) AS bytes FROM (${rootFields})`).get(...scope) as { bytes: number };
    reserve(1, fieldsSize.bytes);
    const root = database.prepare(rootFields).get(...scope) as Root;
    if (!/^package:package\.json:[0-9a-f]{64}$/.test(root.inputKey)) throw new WorkspaceReadError("root_package_input_key_invalid", "incompatible");
    const ref: PackageEvidenceRef = { repositoryId, generationId: snapshot.generationId, relativePath: "package.json", inputKey: root.inputKey,
      ...(isPackageName(root.name) ? { packageName: root.name } : {}) };
    if (isPackageName(root.name)) data.package = { ecosystem: "npm", name: root.name,
      ...(root.versionType === "text" && root.version !== null && root.version.length <= 4096 ? { version: root.version } : {}), provenance: ref };
    if (packageRequested) {
      if (root.nameType === null || isPackageName(root.name)) {
        data.packageDeclarationCoverage = { status: "supported", scanComplete: true, knownInspected: data.package ? 1 : 0,
          reasons: root.nameType === null ? ["root_package_name_absent"] : [] };
      } else fail(data.packageDeclarationCoverage, "package", "package_name_unsupported");
    }
    if (!dependencyRequested) return data;
    try {
      // Validate all four section types before producing any dependency, including when kind-filtered.
      for (const kind of DEPENDENCY_KINDS) {
        checkWorkspaceDeadline(budget);
        const section = database.prepare(`SELECT json_type(record, ?) AS type FROM (${rootSql})`).get("$.values." + kind, ...scope) as { type: string | null };
        if (section.type !== null && section.type !== "object") throw new WorkspaceReadError("dependency_section_invalid", "incompatible");
      }
      const kinds = input.dependencyKind ? [input.dependencyKind] : DEPENDENCY_KINDS;
      const keyFilter = input.packageName === undefined ? "" : " WHERE d.key = ? COLLATE BINARY";
      const keyParams = input.packageName === undefined ? [] : [input.packageName];
      let total = 0, bytes = 0;
      for (const kind of kinds) {
        checkWorkspaceDeadline(budget);
        const sectionSql = `SELECT d.key, d.type, CASE WHEN d.type = 'text' THEN d.value END AS spec
          FROM (${rootSql}), json_each(record, ?) d${keyFilter}`;
        const sectionSize = database.prepare(`SELECT count(*) AS count,
          coalesce(sum(length(CAST(key AS BLOB)) + coalesce(length(CAST(spec AS BLOB)),0)),0) AS bytes,
          coalesce(max(length(key)),0) AS maxKey, coalesce(max(length(spec)),0) AS maxSpec,
          count(DISTINCT key) AS uniqueCount FROM (SELECT * FROM (${sectionSql}) LIMIT ?)`)
          .get(...scope, "$.values." + kind, ...keyParams, remaining + 1) as Size & { maxKey: number; maxSpec: number; uniqueCount: number };
        if (sectionSize.maxKey > 4096 || sectionSize.maxSpec > 4096) throw new WorkspaceReadError("dependency_field_size_exceeded", "partial");
        if (sectionSize.uniqueCount !== sectionSize.count) throw new WorkspaceReadError("dependency_record_invalid", "incompatible");
        total += sectionSize.count; bytes += sectionSize.bytes;
      }
      reserve(total, bytes); // Every selected section is preflighted before the first declaration array.
      for (const kind of kinds) {
        checkWorkspaceDeadline(budget);
        const rows = database.prepare(`SELECT d.key AS name, d.type, CASE WHEN d.type = 'text' THEN d.value END AS spec
          FROM (${rootSql}), json_each(record, ?) d${keyFilter} ORDER BY d.key COLLATE BINARY LIMIT ?`)
          .all(...scope, "$.values." + kind, ...keyParams, total) as { name: string; type: string; spec: string | null }[];
        for (const row of rows) {
          checkWorkspaceDeadline(budget);
          const supported = isPackageName(row.name) && isRegistrySpec(row.spec);
          const reason = !isPackageName(row.name) ? "dependency_name_unsupported" : row.type !== "text" ? "dependency_spec_type_unsupported" : "dependency_spec_unsupported";
          data.dependencies.push({ kind, declaredName: row.name, ...(row.spec !== null ? { rawSpec: row.spec } : {}),
            ...(supported ? { targetPackageName: row.name } : { reason }), supported,
            provenance: { ...ref, dependencyKind: kind, declaredName: row.name } });
        }
      }
      data.dependencyDeclarationCoverage = { status: "supported", scanComplete: true, knownInspected: data.dependencies.length, reasons: [] };
    } catch (error) {
      data.dependencyDeclarationCoverage.knownInspected = data.dependencies.length;
      fail(data.dependencyDeclarationCoverage, "dependency", error instanceof WorkspaceReadError ? error.code : "package_read_failed",
        error instanceof WorkspaceReadError && error.availability === "incompatible");
    }
  } catch (error) {
    const code = error instanceof WorkspaceReadError ? error.code : "package_read_failed";
    const unsupported = error instanceof WorkspaceReadError && error.availability === "incompatible";
    fail(data.packageDeclarationCoverage, "package", code, unsupported);
    fail(data.dependencyDeclarationCoverage, "dependency", code, unsupported);
  }
  return data;
}
