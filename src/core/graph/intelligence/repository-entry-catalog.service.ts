import { decodeFrameworkRouteIdentity, frameworkEntityKey } from "../../framework/framework-identity.js";
import type { FrameworkRelationship } from "../../framework/framework.types.js";
import type { FrameworkQueryProjection } from "../query/framework-query.types.js";
import type {
  RepositoryEntry, RepositoryEntryBinding, RepositoryEntryCatalog, RepositoryEntryDiagnostic, RepositoryEntryFilters,
  RepositoryEntryFramework, RepositoryEntryKind,
} from "./repository-entry-catalog.types.js";

const SUPPORTED_FRAMEWORKS = new Set(["nestjs", "spring", "next"]);

export function buildRepositoryEntryCatalog(framework: FrameworkQueryProjection | undefined): RepositoryEntryCatalog {
  if (!framework) return { entries: [], diagnostics: [], frameworkDiagnostics: [], mayBeIncomplete: true };

  const languageNodes = new Map(framework.nodes.flatMap((item) => item.kind === "language" ? [[item.node.id, item.node] as const] : []));
  const relationshipsByEntity = new Map<string, FrameworkRelationship[]>();
  for (const item of framework.edges) {
    if (item.kind !== "framework" || item.relationship.target.kind !== "framework") continue;
    try {
      const key = frameworkEntityKey(item.relationship.target.entity);
      relationshipsByEntity.set(key, [...(relationshipsByEntity.get(key) ?? []), item.relationship]);
    } catch {
      // Accepted materialization supplies valid refs; malformed projections cannot create an entry.
    }
  }

  const entries: RepositoryEntry[] = [];
  const diagnostics: RepositoryEntryDiagnostic[] = [];
  for (const item of framework.nodes) {
    if (item.kind !== "framework" || item.entity.ref.kind !== "route" || !SUPPORTED_FRAMEWORKS.has(item.entity.ref.framework)) continue;
    const entity = item.entity;
    const identity = decodeFrameworkRouteIdentity(entity.ref);
    if (!identity) {
      diagnostics.push({ code: "invalid_route_identity", entityId: JSON.stringify(entity.ref), subjectIds: [] });
      continue;
    }
    const id = frameworkEntityKey(entity.ref);
    const isNext = entity.ref.framework === "next";
    const expectedRelation = isNext ? "route_binding" : "controller_route";
    const relationships = relationshipsByEntity.get(id) ?? [];
    const bindings: RepositoryEntryBinding[] = [];
    const unsupported: string[] = [];
    let hasUnsupportedBinding = false;
    for (const relationship of relationships) {
      const node = relationship.source.kind === "language" ? languageNodes.get(relationship.source.nodeId) : undefined;
      if (relationship.relationKind !== expectedRelation || !node || (isNext ? node.type !== "file" : node.type !== "function" && node.type !== "method")) {
        hasUnsupportedBinding = true;
        if (relationship.source.kind === "language") unsupported.push(relationship.source.nodeId);
        continue;
      }
      bindings.push({ subjectId: node.id, bindingKind: isNext ? "file_boundary" : "callable", provenance: relationship.provenance });
    }
    bindings.sort((left, right) => left.subjectId.localeCompare(right.subjectId)
      || JSON.stringify(left.provenance).localeCompare(JSON.stringify(right.provenance)));
    if (hasUnsupportedBinding) diagnostics.push({ code: "unsupported_binding", entityId: id, subjectIds: [...new Set(unsupported)].sort() });
    if (bindings.length === 0) {
      if (relationships.length === 0) diagnostics.push({ code: "binding_missing", entityId: id, subjectIds: [] });
      continue;
    }
    const boundIds = [...new Set(bindings.map((binding) => binding.subjectId))];
    if (boundIds.length > 1) diagnostics.push({ code: "ambiguous_binding", entityId: id, subjectIds: boundIds });
    const [scope, router, path, method, conditions, owner] = identity;
    entries.push({
      id, kind: (isNext ? "web_route" : "http") as RepositoryEntryKind,
      framework: entity.ref.framework as RepositoryEntryFramework, frameworkEntity: entity.ref,
      displayName: entity.displayName, scope, router, path, method, conditions, owner,
      bindings, provenance: entity.provenance,
    });
  }
  // Semantic order: kind, framework, path, method, then canonical framework identity.
  entries.sort((left, right) => left.kind.localeCompare(right.kind) || left.framework.localeCompare(right.framework)
    || left.path.localeCompare(right.path) || (left.method ?? "").localeCompare(right.method ?? "") || left.id.localeCompare(right.id));
  diagnostics.sort((left, right) => left.entityId.localeCompare(right.entityId) || left.code.localeCompare(right.code));
  return {
    entries, diagnostics, frameworkDiagnostics: framework.diagnostics,
    mayBeIncomplete: framework.mayBeIncomplete || diagnostics.length > 0,
    ...(framework.reliability ? { frameworkReliability: framework.reliability } : {}),
  };
}

export function filterRepositoryEntries(entries: readonly RepositoryEntry[], filters: RepositoryEntryFilters): RepositoryEntry[] {
  const method = filters.method?.toUpperCase();
  return entries.filter((entry) => (filters.kind === undefined || entry.kind === filters.kind)
    && (filters.framework === undefined || entry.framework === filters.framework)
    && (filters.path === undefined || entry.path === filters.path)
    && (method === undefined || entry.method?.toUpperCase() === method));
}
