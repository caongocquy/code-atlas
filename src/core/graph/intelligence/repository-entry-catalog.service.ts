import { decodeMessageIdentity, isMessageMetadata } from "../../framework/framework-message.js";
import { decodeScheduledIdentity, isScheduledMetadata } from "../../framework/framework-scheduled.js";
import { decodeFrameworkGraphqlOperationIdentity, decodeFrameworkRouteIdentity, frameworkEntityKey } from "../../framework/framework-identity.js";
import type { FrameworkRelationship } from "../../framework/framework.types.js";
import type { FrameworkQueryProjection } from "../query/framework-query.types.js";
import type {
  RepositoryEntry, RepositoryEntryBinding, RepositoryEntryCatalog, RepositoryEntryDiagnostic, RepositoryEntryFilters,
  RepositoryEntryFramework,
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
    if (item.kind !== "framework" || !["route", "graphql_operation", "scheduled_job", "message_consumer"].includes(item.entity.ref.kind) || !SUPPORTED_FRAMEWORKS.has(item.entity.ref.framework)) continue;
    const entity = item.entity;
    const isMessage = entity.ref.kind === "message_consumer";
    const isScheduled = entity.ref.kind === "scheduled_job";
    const isGraphql = entity.ref.kind === "graphql_operation";
    const identity = isMessage ? decodeMessageIdentity(entity.ref.framework, entity.ref.logicalKey) : isScheduled ? decodeScheduledIdentity(entity.ref.framework, entity.ref.logicalKey) : isGraphql ? decodeFrameworkGraphqlOperationIdentity(entity.ref) : decodeFrameworkRouteIdentity(entity.ref);
    if (!identity) {
      diagnostics.push({ code: isMessage ? "invalid_message_identity" : isScheduled ? "invalid_scheduled_identity" : isGraphql ? "invalid_graphql_identity" : "invalid_route_identity", entityId: JSON.stringify(entity.ref), subjectIds: [] });
      continue;
    }
    const id = frameworkEntityKey(entity.ref);
    const isNext = entity.ref.framework === "next";
    const expectedRelation = isMessage ? "message_handler" : isScheduled ? "scheduled_handler" : isGraphql ? "graphql_resolver" : isNext ? "route_binding" : "controller_route";
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
    if (boundIds.length > 1) {
      diagnostics.push({ code: "ambiguous_binding", entityId: id, subjectIds: boundIds });
      if (isGraphql || isScheduled || isMessage) continue;
    }
    if (isMessage) {
      if (!isMessageMetadata(entity.messageMetadata) || hasUnsupportedBinding || bindings.length !== 1) {
        diagnostics.push({ code: "invalid_message_identity", entityId: id, subjectIds: boundIds });
        continue;
      }
      const [scope, callableKey, protocolKind, consumerKind, destinationKind, destination, identityOptions] = identity as NonNullable<ReturnType<typeof decodeMessageIdentity>>;
      entries.push({ id, kind: "message_consumer", framework: entity.ref.framework as "nestjs" | "spring", frameworkEntity: entity.ref,
        displayName: entity.displayName, scope, callableKey, protocolKind, consumerKind, destinationKind, destination, identityOptions,
        metadata: entity.messageMetadata, exposure: "declared_mapping", bindings, provenance: entity.provenance });
      diagnostics.push({ code: "runtime_registration_unverified", entityId: id, subjectIds: boundIds });
      continue;
    }
    if (isScheduled) {
      if (!isScheduledMetadata(entity.scheduledMetadata) || hasUnsupportedBinding) {
        diagnostics.push({ code: "invalid_scheduled_identity", entityId: id, subjectIds: boundIds });
        continue;
      }
      const [scope, callableKey, triggerKind, schedule, declaredName, modifiers] = identity as NonNullable<ReturnType<typeof decodeScheduledIdentity>>;
      entries.push({ id, kind: "scheduled", framework: entity.ref.framework as "nestjs" | "spring", frameworkEntity: entity.ref,
        displayName: entity.displayName, scope, callableKey, triggerKind, schedule, declaredName, modifiers,
        declaration: entity.scheduledMetadata, exposure: "declared_mapping", bindings, provenance: entity.provenance });
      diagnostics.push({ code: "runtime_registration_unverified", entityId: id, subjectIds: boundIds });
      continue;
    }
    if (isGraphql) {
      const [scope, operationKind, fieldName] = identity as NonNullable<ReturnType<typeof decodeFrameworkGraphqlOperationIdentity>>;
      entries.push({ id, kind: "graphql", framework: entity.ref.framework as "nestjs" | "spring", frameworkEntity: entity.ref,
        displayName: entity.displayName, scope, operationKind, fieldName, exposure: "declared_mapping", bindings, provenance: entity.provenance });
      diagnostics.push({ code: "schema_unverified", entityId: id, subjectIds: boundIds });
      continue;
    }
    const [scope, router, path, method, conditions, owner] = identity as NonNullable<ReturnType<typeof decodeFrameworkRouteIdentity>>;
    entries.push({
      id, kind: isNext ? "web_route" : "http",
      framework: entity.ref.framework as RepositoryEntryFramework, frameworkEntity: entity.ref,
      displayName: entity.displayName, scope, router, path, method, conditions, owner,
      bindings, provenance: entity.provenance,
    });
  }
  // Semantic order: kind, framework, route path/method or GraphQL operation/field, then identity.
  const order = (entry: RepositoryEntry) => entry.kind === "message_consumer"
    ? [entry.protocolKind, JSON.stringify([entry.consumerKind, entry.destinationKind, entry.destination])] : entry.kind === "graphql"
    ? [entry.operationKind, entry.fieldName] : entry.kind === "scheduled" ? [entry.triggerKind, entry.declaredName ?? ""] : [entry.path, entry.method ?? ""];
  entries.sort((left, right) => left.kind.localeCompare(right.kind) || left.framework.localeCompare(right.framework)
    || order(left)[0]!.localeCompare(order(right)[0]!) || order(left)[1]!.localeCompare(order(right)[1]!) || left.id.localeCompare(right.id));
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
    && (filters.path === undefined || ((entry.kind === "http" || entry.kind === "web_route") && entry.path === filters.path))
    && (method === undefined || ((entry.kind === "http" || entry.kind === "web_route") && entry.method?.toUpperCase() === method))
    && (filters.triggerKind === undefined || (entry.kind === "scheduled" && entry.triggerKind === filters.triggerKind))
    && (filters.declaredName === undefined || (entry.kind === "scheduled" && entry.declaredName === filters.declaredName))
    && (filters.protocolKind === undefined || (entry.kind === "message_consumer" && entry.protocolKind === filters.protocolKind))
    && (filters.consumerKind === undefined || (entry.kind === "message_consumer" && entry.consumerKind === filters.consumerKind))
    && (filters.destinationKind === undefined || (entry.kind === "message_consumer" && entry.destinationKind === filters.destinationKind))
    && (filters.destination === undefined || (entry.kind === "message_consumer" && entry.destination === filters.destination)));
}
