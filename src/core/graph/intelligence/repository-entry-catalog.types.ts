import type { FrameworkDiagnostic, FrameworkEntityRef, FrameworkProvenance } from "../../framework/framework.types.js";
import type { ReliabilityProjection } from "../../reliability/reliability.types.js";

export type RepositoryEntryKind = "http" | "web_route" | "graphql";
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
  operationKind: "query" | "mutation";
  fieldName: string;
  exposure: "declared_mapping";
};

export type RepositoryEntry = RepositoryRouteEntry | RepositoryGraphqlEntry;

export type RepositoryEntryDiagnostic = {
  code: "invalid_route_identity" | "invalid_graphql_identity" | "binding_missing" | "unsupported_binding" | "ambiguous_binding" | "schema_unverified";
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
};
