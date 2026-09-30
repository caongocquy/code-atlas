import type { FrameworkDiagnostic, FrameworkEntityRef, FrameworkProvenance } from "../../framework/framework.types.js";
import type { ReliabilityProjection } from "../../reliability/reliability.types.js";

export type RepositoryEntryKind = "http" | "web_route";
export type RepositoryEntryFramework = "nestjs" | "spring" | "next";
export type RepositoryEntryBindingKind = "callable" | "file_boundary";

export type RepositoryEntryBinding = {
  subjectId: string;
  bindingKind: RepositoryEntryBindingKind;
  provenance: FrameworkProvenance;
};

export type RepositoryEntry = {
  id: string;
  kind: RepositoryEntryKind;
  framework: RepositoryEntryFramework;
  frameworkEntity: FrameworkEntityRef;
  displayName: string;
  scope: string;
  router: string;
  path: string;
  method: string | null;
  conditions: readonly string[];
  owner: string | null;
  bindings: readonly RepositoryEntryBinding[];
  provenance: FrameworkProvenance;
};

export type RepositoryEntryDiagnostic = {
  code: "invalid_route_identity" | "binding_missing" | "unsupported_binding" | "ambiguous_binding";
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
