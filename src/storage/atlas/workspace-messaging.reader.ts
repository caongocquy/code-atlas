import path from "node:path";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";
import type { WorkspaceSnapshot } from "./workspace-metadata.reader.js";
import { checkWorkspaceDeadline, reserveWorkspaceRead } from "./workspace-metadata.reader.js";
import { decodeMessageConsumerRecord, decodeMessageRelationshipRecord, validateMessageConsumerSlice } from "./atlas.store.js";
import { WORKSPACE_BOUNDS, WorkspaceReadError, type WorkspaceReadBudget } from "../../core/workspace/workspace.types.js";
import type { WorkspaceMessagingInputs, WorkspaceRoleCoverage, WorkspaceMessageLinksInput } from "../../core/workspace/workspace-message-links.types.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../../core/repository/index-version.js";
import { factBlobKey } from "../../core/facts/facts-identity.js";
import { decodeFacts } from "../../core/facts/facts-codec.js";
import type { FactBlobKey, ParsedFactsBlob, ParserIdentity } from "../../core/facts/facts.types.js";
import type { GraphNode } from "../../core/graph/types.js";
import type { FrameworkRelationship } from "../../core/framework/framework.types.js";
import { frameworkEntityKey } from "../../core/framework/framework-identity.js";
import { decodeMessageIdentity } from "../../core/framework/framework-message.js";
import { detectMessageProducers } from "../../core/graph/intelligence/message-producer-evidence.js";
import { buildRepositoryEntryCatalog } from "../../core/graph/intelligence/repository-entry-catalog.service.js";
import { projectFrameworkGraph } from "../../core/graph/query/framework-query.service.js";

export function roleCoverage(requested: boolean): WorkspaceRoleCoverage {
  return { status: requested ? "unavailable" : "not_requested", scanComplete: !requested, knownInspected: 0, reasons: [] };
}

export function readWorkspaceMessaging(database: DatabaseSync, snapshot: WorkspaceSnapshot, repositoryId: string,
  budget: WorkspaceReadBudget, metadataRecords: number, input: WorkspaceMessageLinksInput): WorkspaceMessagingInputs {
  const source = input.sourceRepositoryId === undefined || input.sourceRepositoryId === repositoryId;
  const target = input.targetRepositoryId === undefined || input.targetRepositoryId === repositoryId;
  const result: WorkspaceMessagingInputs = { producers: [], consumers: [], callables: [], producerCoverage: roleCoverage(source), consumerCoverage: roleCoverage(target), diagnostics: [] };
  const scope: SQLInputValue[] = [repositoryId, snapshot.generationId];
  let records = metadataRecords;
  const scanComplete = { producer: true, consumer: true };
  const incomplete = (role: "producer" | "consumer", code: string) => {
    scanComplete[role] = false;
    const coverage = role === "producer" ? result.producerCoverage : result.consumerCoverage;
    if (!coverage.reasons.includes(code)) { coverage.reasons.push(code); result.diagnostics.push({ repositoryId, generationId: snapshot.generationId, role, code }); }
  };
  const reserve = (count: number, bytes = 0) => {
    if (records + count > WORKSPACE_BOUNDS.maxRecordsPerRepository) throw new WorkspaceReadError("record_budget_exceeded", "partial");
    reserveWorkspaceRead(budget, count, bytes); records += count;
  };
  // Each row has a byte preflight in the same transaction before any string/payload hydration.
  // OFFSET is bounded to at most the per-member record ceiling, never an unbounded .all().
  function* rows<T>(sql: string, params: SQLInputValue[], fields: string[]): Generator<T> {
    for (let offset = 0; ; offset++) {
      checkWorkspaceDeadline(budget);
      const query = `${sql} LIMIT 1 OFFSET ?`;
      const size = database.prepare(`SELECT ${fields.map(f => `coalesce(length(CAST(${f} AS BLOB)), 0)`).join(" + ") || "0"} AS bytes FROM (${query})`).get(...params, offset) as { bytes: number } | undefined;
      if (!size) return;
      reserve(1, size.bytes);
      const row = database.prepare(query).get(...params, offset) as T;
      yield row;
      checkWorkspaceDeadline(budget);
    }
  }
  const factsCache = new Map<string, ParsedFactsBlob>();
  const factKeys = new Map<string, FactBlobKey>();
  const callableCache = new Map<string, GraphNode[]>();
  function callables(file: string): GraphNode[] {
    const cached = callableCache.get(file); if (cached) return cached;
    const nodes = [...rows<{ id: string; type: string; name: string; qualified_name: string | null; file_path: string; start_line: number | null; end_line: number | null }>(
      "SELECT id, type, name, qualified_name, file_path, start_line, end_line FROM generation_symbols WHERE repository_id = ? AND generation_id = ? AND file_path = ? AND type IN ('function','method') ORDER BY id", [...scope, file], ["id", "type", "name", "qualified_name", "file_path"])]
      .map(r => ({ id: r.id, type: r.type as "function" | "method", name: r.name, qualifiedName: r.qualified_name ?? undefined, file: r.file_path, startLine: r.start_line ?? undefined, endLine: r.end_line ?? undefined }));
    callableCache.set(file, nodes); return nodes;
  }
  type Binding = { repository_id: string; generation_id: string; relative_path: string; fact_blob_key: FactBlobKey; content_hash: string; language: string };
  const bindingFields = ["repository_id", "generation_id", "relative_path", "fact_blob_key", "content_hash", "language"];
  const bindingSql = "SELECT repository_id, generation_id, relative_path, fact_blob_key, content_hash, language FROM file_fact_bindings WHERE repository_id = ? AND generation_id = ?";
  function facts(binding: Binding): ParsedFactsBlob {
    const file = binding.relative_path;
    if (binding.repository_id !== repositoryId || binding.generation_id !== snapshot.generationId || !file || file.includes("\\") || path.posix.isAbsolute(file) || /^[A-Za-z]:/.test(file) || path.posix.normalize(file) !== file || file === "." || file === ".." || file.startsWith("../")) throw new WorkspaceReadError("fact_binding_invalid");
    const cached = factsCache.get(file); if (cached) return cached;
    const blob = rows<{ payload_json: string; parser_identity_json: string; language: string; content_hash: string; facts_version: string; facts_schema_version: string; fact_records: number }>(
      "SELECT payload_json, parser_identity_json, language, content_hash, facts_version, facts_schema_version, CASE WHEN json_valid(payload_json) THEN (SELECT coalesce(sum(json_array_length(value)), 0) FROM json_each(payload_json) WHERE type = 'array') + coalesce(json_array_length(payload_json, '$.frameworkSyntax.nodes'), 0) ELSE -1 END AS fact_records FROM fact_blobs WHERE fact_blob_key = ? ORDER BY fact_blob_key", [binding.fact_blob_key], ["payload_json", "parser_identity_json", "language", "content_hash", "facts_version", "facts_schema_version"]).next().value;
    if (!blob) throw new WorkspaceReadError("fact_blob_unavailable");
    if (blob.content_hash !== binding.content_hash || blob.language !== binding.language || blob.facts_version !== snapshot.versions.factsVersion || blob.facts_schema_version !== snapshot.versions.factsSchemaVersion) throw new WorkspaceReadError("fact_provenance_mismatch");
    if (!Number.isSafeInteger(blob.fact_records) || blob.fact_records < 0) throw new WorkspaceReadError("fact_blob_invalid");
    // Native SQLite counts fact records before JavaScript parses or validates any fact arrays.
    reserve(blob.fact_records);
    const decoded = decodeFacts(blob.payload_json, { key: binding.fact_blob_key, contentHash: binding.content_hash, language: binding.language as ParsedFactsBlob["language"], factsVersion: snapshot.versions.factsVersion, factsSchemaVersion: snapshot.versions.factsSchemaVersion!, parserIdentity: JSON.parse(blob.parser_identity_json) as ParserIdentity });
    if (decoded.kind !== "hit" || factBlobKey(decoded.facts) !== binding.fact_blob_key) throw new WorkspaceReadError("fact_blob_invalid");
    const value = decoded.facts;
    factsCache.set(file, value); factKeys.set(file, binding.fact_blob_key); return value;
  }
  const loadFileFacts = (file: string) => {
    const binding = rows<Binding>(`${bindingSql} AND relative_path = ? ORDER BY relative_path`, [...scope, file], bindingFields).next().value;
    if (!binding) throw new WorkspaceReadError("fact_binding_unavailable");
    return facts(binding);
  };
  const profile = (role: "producer" | "consumer") => {
    const domains = role === "producer" ? ["schemaVersion", "factsVersion", "factsSchemaVersion", "resolutionVersion"] as const
      : ["schemaVersion", "frameworkResolutionVersion", "resolutionVersion", "factsVersion", "factsSchemaVersion"] as const;
    return domains.every(key => snapshot.versions[key] === CURRENT_INDEX_VERSION_DOMAINS[key]);
  };
  const run = (role: "producer" | "consumer", requested: boolean, read: () => void) => {
    if (!requested) return;
    const coverage = role === "producer" ? result.producerCoverage : result.consumerCoverage;
    if (!profile(role)) { coverage.status = "unsupported"; coverage.reasons.push("semantic_role_unsupported"); result.diagnostics.push({ repositoryId, generationId: snapshot.generationId, role, code: "semantic_role_unsupported" }); return; }
    coverage.status = "supported";
    const before = records;
    try { read(); coverage.scanComplete = scanComplete[role]; }
    catch (error) {
      const missing = error instanceof Error && /no such (table|column)/i.test(error.message);
      const code = error instanceof WorkspaceReadError ? error.code : missing ? "role_contract_unsupported" : `${role}_evidence_invalid`;
      coverage.status = missing || (error instanceof WorkspaceReadError && error.availability === "incompatible") ? "unsupported" : error instanceof WorkspaceReadError && error.availability === "partial" ? "supported" : "unavailable";
      coverage.reasons.push(code);
      result.diagnostics.push({ repositoryId, generationId: snapshot.generationId, role, code });
      if (coverage.status !== "supported") { if (role === "consumer") result.consumers = []; else { result.producers = []; result.callables = []; } }
    } finally { coverage.knownInspected = records - before; }
  };
  // Target keys are collected before producers; both stay inside the same member transaction.
  run("consumer", target, () => {
    const state = rows<{ framework_resolution_version: string; detections_json: string; complete: number; detection_records: number }>(
      "SELECT framework_resolution_version, detections_json, complete, CASE WHEN json_valid(detections_json) THEN json_array_length(detections_json) ELSE -1 END AS detection_records FROM generation_framework_state WHERE repository_id = ? AND generation_id = ? ORDER BY repository_id", scope, ["framework_resolution_version", "detections_json"]).next().value;
    if (!state || state.framework_resolution_version !== snapshot.versions.frameworkResolutionVersion) throw new WorkspaceReadError("consumer_contract_unsupported", "incompatible");
if (![0, 1].includes(state.complete) || !Number.isSafeInteger(state.detection_records) || state.detection_records < 0) throw new WorkspaceReadError("consumer_evidence_invalid");
    reserve(state.detection_records);
    const detections: unknown = JSON.parse(state.detections_json);
    if (!Array.isArray(detections)) throw new WorkspaceReadError("consumer_evidence_invalid");
validateMessageConsumerSlice(repositoryId, state.framework_resolution_version, [], [], [], detections, new Map());
    if (state.complete !== 1) incomplete("consumer", "consumer_declaration_incomplete");
    const entities = [...rows<{ entity_key: string; payload_json: string; framework: string; kind: string; logical_key: string }>(
      "SELECT entity_key, payload_json, framework, kind, logical_key FROM generation_framework_entities WHERE repository_id = ? AND generation_id = ? AND (kind = 'message_consumer' OR entity_key LIKE '%\"message_consumer\"%') ORDER BY entity_key", scope, ["entity_key", "payload_json", "framework", "kind", "logical_key"])]
      .map(row => {
        const entity = decodeMessageConsumerRecord(row.payload_json, row.entity_key);
        if (row.framework !== entity.ref.framework || row.kind !== entity.ref.kind || row.logical_key !== entity.ref.logicalKey) throw new WorkspaceReadError("consumer_identity_mismatch");
        return entity;
      });
    if (entities.length === 0) return;
    const keys = new Set(entities.map(e => frameworkEntityKey(e.ref)));
    // The schema has no typed endpoint columns. Inspect bounded relationship rows once;
    // retain only those touching selected consumers, including invalid-direction candidates.
    const relationships: FrameworkRelationship[] = [];
    for (const row of rows<{ output_key: string; payload_json: string }>(
      "SELECT output_key, payload_json FROM generation_framework_relationships WHERE repository_id = ? AND generation_id = ? ORDER BY output_key", scope, ["output_key", "payload_json"])) {
      const r = decodeMessageRelationshipRecord(row.payload_json, row.output_key);
      if ((r.source.kind === "framework" && keys.has(frameworkEntityKey(r.source.entity))) || (r.target.kind === "framework" && keys.has(frameworkEntityKey(r.target.entity)))) relationships.push(r);
    }
    const files = [...new Set(entities.map(e => decodeMessageIdentity(e.ref.framework, e.ref.logicalKey)![1][0]))].sort();
    const nodes = files.flatMap(callables);
    // C-D may require annotation ownership when persisted qualified names are insufficient.
    // Keep that same proof path, using validated same-generation facts only.
    const sourceFacts = new Map(files.map(file => [file, loadFileFacts(file)]));
    const normalized = validateMessageConsumerSlice(repositoryId, state.framework_resolution_version, entities, relationships, nodes, detections, sourceFacts);
    const catalog = buildRepositoryEntryCatalog(projectFrameworkGraph({ nodes, edges: [] }, { repositoryId, generationId: snapshot.generationId, ...normalized }));
    result.consumers = catalog.entries.flatMap(e => e.kind === "message_consumer" ? [e] : []);
    if (result.consumers.length !== entities.length) throw new WorkspaceReadError("consumer_binding_invalid");
  });
  run("producer", source, () => {
    let selectedFile: string | undefined;
    let selectorUnresolved = false;
    if (input.producerSymbol !== undefined) {
      const selector = input.producerSymbol;
      const matches = [...rows<{ id: string; type: GraphNode["type"]; name: string; qualified_name: string | null; file_path: string }>(
        "SELECT id, type, name, qualified_name, file_path FROM generation_symbols WHERE repository_id = ? AND generation_id = ? AND (id = ? OR name = ? OR qualified_name = ? OR file_path || ':' || name = ? OR file_path || ':' || qualified_name = ?) ORDER BY id", [...scope, selector, selector, selector, selector, selector], ["id", "type", "name", "qualified_name", "file_path"])];
      result.callables.push(...matches.map(n => ({ id: n.id, type: n.type, name: n.name, file: n.file_path, qualifiedName: n.qualified_name ?? undefined })));
      if (matches.length !== 1) selectorUnresolved = true;
      else {
        if (!["function", "method"].includes(matches[0].type)) return;
        selectedFile = matches[0].file_path;
      }
    }
    for (const binding of rows<Binding>(`${bindingSql}${selectedFile !== undefined ? " AND relative_path = ?" : ""} AND language IN ('typescript','java') ORDER BY relative_path`, selectedFile !== undefined ? [...scope, selectedFile] : scope, bindingFields)) {
      const fileFacts = facts(binding);
      if (fileFacts.parseStatus !== "complete" || !fileFacts.frameworkSyntax?.complete) incomplete("producer", "producer_facts_incomplete");
      // Absence/ambiguity requires bounded completeness inspection, never a detector widening.
      if (selectorUnresolved) continue;
      const nodes = callables(binding.relative_path);
      checkWorkspaceDeadline(budget);
      const detection = detectMessageProducers([{ relativePath: binding.relative_path, facts: fileFacts }], { nodes, edges: [] }, snapshot.generationId);
      reserve(detection.producers.length + detection.diagnostics.length);
      result.producers.push(...detection.producers.map(p => ({ ...p, callRef: { ...p.callRef, factBlobKey: factKeys.get(binding.relative_path) } })));
      result.diagnostics.push(...detection.diagnostics.map(d => ({ repositoryId, generationId: snapshot.generationId, role: "producer" as const, code: d.code, ref: { file: d.file, id: d.callId } })));
      result.callables.push(...nodes);
      checkWorkspaceDeadline(budget);
    }
  });
  return result;
}
