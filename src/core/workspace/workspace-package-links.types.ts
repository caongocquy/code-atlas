import type { WorkspaceMapInput } from "./workspace.types.js";

export const DEPENDENCY_KINDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"] as const;
export type DependencyKind = typeof DEPENDENCY_KINDS[number];
export type WorkspacePackageLinksInput = WorkspaceMapInput & {
  sourceRepositoryId?: string; targetRepositoryId?: string; packageName?: string; dependencyKind?: DependencyKind;
};
export type PackageRoleCoverage = {
  status: "supported" | "unsupported" | "unavailable" | "not_requested";
  scanComplete: boolean; knownInspected: number; reasons: string[];
};
export type PackageEvidenceRef = {
  repositoryId: string; generationId: string; relativePath: "package.json"; inputKey: string;
  packageName?: string; dependencyKind?: DependencyKind; declaredName?: string;
};
export type PackageDeclaration = {
  ecosystem: "npm"; name: string; version?: string; provenance: PackageEvidenceRef;
};
export type DependencyDeclaration = {
  kind: DependencyKind; declaredName: string; targetPackageName?: string; rawSpec?: string;
  supported: boolean; reason?: string; provenance: PackageEvidenceRef;
};
export type PackageDiagnostic = { repositoryId: string; generationId?: string; role: "package" | "dependency" | "member"; code: string; ref?: PackageEvidenceRef };
export type WorkspacePackageInputs = {
  packageDeclarationCoverage: PackageRoleCoverage; dependencyDeclarationCoverage: PackageRoleCoverage;
  package?: PackageDeclaration; dependencies: DependencyDeclaration[]; diagnostics: PackageDiagnostic[];
};
export type PackageEndpoint = { repositoryId: string; generationId: string; path: string; package?: PackageDeclaration };
export type PackageDependencyRecord = {
  source: PackageEndpoint & { dependency: DependencyDeclaration };
  status: "candidate" | "unmatched" | "unresolved"; cardinality: "one" | "many" | "none" | "unknown"; reason?: string;
};
export type WorkspacePackageLink = {
  source: PackageDependencyRecord["source"];
  target: PackageEndpoint & { package: PackageDeclaration };
  relation: { kind: "declared_dependency_candidate"; scope: "workspace_cross_repo"; nameMatch: "exact" };
};

export function isPackageName(value: unknown): value is string {
  return typeof value === "string" && value.length <= 214 && value !== "node_modules" && value !== "favicon.ico"
    && /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/.test(value);
}
export function isRegistrySpec(value: unknown): value is string {
  if (typeof value !== "string") return false;
  if (["*", "latest", "next"].includes(value)) return true;
  if (!/^[~^]?(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/.test(value)) return false;
  return value.replace(/^[~^]/, "").split(".").every(part => Number.isSafeInteger(Number(part)));
}
export function packageRoleCoverage(requested: boolean): PackageRoleCoverage {
  return { status: requested ? "unavailable" : "not_requested", scanComplete: !requested, knownInspected: 0, reasons: [] };
}
