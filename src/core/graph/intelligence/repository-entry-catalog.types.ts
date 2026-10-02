import type { ScheduledTriggerKind, ScheduledSpec, ScheduledModifiers, ScheduledMetadata } from "../../framework/framework-scheduled.js";
import type { FrameworkDiagnostic, FrameworkEntityRef, FrameworkProvenance } from "../../framework/framework.types.js";
import type { ReliabilityProjection } from "../../reliability/reliability.types.js";

export type RepositoryEntryKind = "http" | "web_route" | "graphql" | "scheduled";
export type RepositoryEntryFramework = "nestjs" | "spring" | "next";
export type RepositoryEntryBindingKind = "callable" | "file_boundary";

export type RepositoryEntryBinding = {
  subjectId: string;
  bindingKind: RepositoryEntryBindingKind;
  provenance: FrameworkProvenance;
};

type RepositoryEntryBase = {
  id: string;
  framework: RepositoryEntryFramework;
  frameworkEntity: FrameworkEntityRef;
  displayName: string;
  scope: string;
  bindings: readonly RepositoryEntryBinding[];
  provenance: FrameworkProvenance;
};

export type RepositoryRouteEntry = RepositoryEntryBase & {
  kind: "http" | "web_route";
  router: string;
  path: string;
  method: string | null;
  conditions: readonly string[];
  owner: string | null;
};

export type RepositoryGraphqlEntry = RepositoryEntryBase & {
  kind: "graphql";
  framework: "nestjs" | "spring";
  operationKind: "query" | "mutation" | "subscription";
  fieldName: string;
  exposure: "declared_mapping";
};

export type RepositoryScheduledEntry = RepositoryEntryBase & {
  kind: "scheduled";
  framework: "nestjs" | "spring";
  callableKey: readonly [file: string, typePath: string, method: string];
  triggerKind: ScheduledTriggerKind;
  schedule: ScheduledSpec;
  declaredName: string | null;
  modifiers: ScheduledModifiers;
  declaration: ScheduledMetadata;
  exposure: "declared_mapping";
};
export type RepositoryEntry = RepositoryRouteEntry | RepositoryGraphqlEntry | RepositoryScheduledEntry;

export type RepositoryEntryDiagnostic = {
  code: "invalid_scheduled_identity" | "runtime_registration_unverified" | "invalid_route_identity" | "invalid_graphql_identity" | "binding_missing" | "unsupported_binding" | "ambiguous_binding" | "schema_unverified";
  entityId: string;
  subjectIds: readonly string[];
};

export type RepositoryEntryCatalog = {
  entries: RepositoryEntry[];
  diagnostics: RepositoryEntryDiagnostic[];
  frameworkDiagnostics: readonly FrameworkDiagnostic[];
  mayBeIncomplete: boolean;
  frameworkReliability?: ReliabilityProjection;
};

export type RepositoryEntryFilters = {
  kind?: RepositoryEntryKind;
  framework?: RepositoryEntryFramework;
  path?: string;
  method?: string;
  triggerKind?: ScheduledTriggerKind;
  declaredName?: string;
};
