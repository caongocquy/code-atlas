import { exactProjectionCount } from "../projection/known-collection.js";
import { coordinateWorkspaceMembers, createWorkspaceBudget } from "./workspace-coordinator.js";
import { resolveWorkspaceMembership } from "./workspace-membership.js";
import { WORKSPACE_BOUNDS, WORKSPACE_CONSISTENCY, WorkspaceMapError } from "./workspace.types.js";
import { checkWorkspaceDeadline, reserveWorkspaceRead } from "../../storage/atlas/workspace-metadata.reader.js";
import { readWorkspacePackages } from "../../storage/atlas/workspace-package.reader.js";
import { DEPENDENCY_KINDS, isPackageName, packageRoleCoverage, type PackageRoleCoverage, type PackageDiagnostic, type PackageDeclaration,
  type PackageDependencyRecord, type WorkspacePackageInputs, type WorkspacePackageLink, type WorkspacePackageLinksInput } from "./workspace-package-links.types.js";

export const WORKSPACE_PACKAGE_LIMITATION = "Declared cross-repository package dependency candidates from indexed manifests. These do not prove installation, version satisfaction, module-loader resolution, runtime use, artifact origin, or shared deployment.";
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const complete = (coverage: PackageRoleCoverage) => coverage.status === "supported" && coverage.scanComplete;
function validate(input: WorkspacePackageLinksInput): number {
  const keys = ["repositories","workspacePath","sourceRepositoryId","targetRepositoryId","packageName","dependencyKind","limit","detail"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) throw new WorkspaceMapError("invalid_arguments", "Invalid workspace package input.");
  for (const key of ["sourceRepositoryId","targetRepositoryId"] as const) if (input[key] !== undefined &&
    (typeof input[key] !== "string" || !input[key] || input[key].length > 4096 || input[key].includes("\0"))) throw new WorkspaceMapError("invalid_arguments", "Invalid repository selector.");
  if (input.sourceRepositoryId !== undefined && input.sourceRepositoryId === input.targetRepositoryId) throw new WorkspaceMapError("invalid_arguments", "Package candidates require distinct source and target repositories.");
  if (input.packageName !== undefined && !isPackageName(input.packageName)) throw new WorkspaceMapError("invalid_arguments", "Unsupported exact package name.");
  if (input.dependencyKind !== undefined && !DEPENDENCY_KINDS.includes(input.dependencyKind)) throw new WorkspaceMapError("invalid_arguments", "Unsupported dependency kind.");
  const limit = input.limit ?? WORKSPACE_BOUNDS.defaultDetailLimit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKSPACE_BOUNDS.maxDetailLimit || (input.detail !== undefined && !["compact","full"].includes(input.detail))) throw new WorkspaceMapError("invalid_arguments", "Invalid limit/detail.");
  return limit;
}
export async function queryWorkspacePackageLinks(input: WorkspacePackageLinksInput, options: { cwd?: string; now?: () => number } = {}) {
  const limit = validate(input), budget = createWorkspaceBudget(options.now ?? (() => performance.now()), WORKSPACE_BOUNDS);
  const selected = await resolveWorkspaceMembership(input, options.cwd ?? process.cwd(), budget);
  const ids = new Set(selected.identities.map(i => i.id));
  for (const id of [input.sourceRepositoryId,input.targetRepositoryId]) if (id !== undefined && !ids.has(id)) throw new WorkspaceMapError("invalid_arguments", "Endpoint must belong to selected workspace.");
  const inputs = new Map<string, WorkspacePackageInputs>();
  const coordinated = await coordinateWorkspaceMembers(selected.identities, budget, (database, snapshot, identity, records) => {
    inputs.set(identity.id, readWorkspacePackages(database, snapshot, identity.id, budget, records, input));
  }, "packages");
  const repositories = coordinated.repositories.map(member => {
    const data = inputs.get(member.repositoryId);
    const packageDeclarationCoverage = data?.packageDeclarationCoverage ?? packageRoleCoverage(!input.targetRepositoryId || input.targetRepositoryId === member.repositoryId);
    const dependencyDeclarationCoverage = data?.dependencyDeclarationCoverage ?? packageRoleCoverage(!input.sourceRepositoryId || input.sourceRepositoryId === member.repositoryId);
    if (!data) for (const coverage of [packageDeclarationCoverage,dependencyDeclarationCoverage]) if (coverage.status !== "not_requested") coverage.reasons = [...member.health.diagnostics];
    const roles = [packageDeclarationCoverage,dependencyDeclarationCoverage].filter(r => r.status !== "not_requested");
    const diagnostics: PackageDiagnostic[] = [...member.health.diagnostics.map(code => ({ repositoryId: member.repositoryId,
      ...(member.generationId ? { generationId: member.generationId } : {}), role: "member" as const, code })), ...(data?.diagnostics ?? [])];
    const health = member.generationId === null ? member.health : { ...member.health,
      availability: roles.length && roles.every(r => r.status === "unsupported") ? "incompatible" as const
        : roles.length && roles.every(r => r.status === "unavailable") ? "unavailable" as const
        : roles.some(r => !complete(r)) ? "partial" as const : member.health.availability,
      compatibility: roles.length && roles.every(r => r.status === "unsupported") ? "incompatible" as const : member.health.compatibility,
      diagnostics: [...new Set([...member.health.diagnostics,...roles.flatMap(r => r.reasons)])].sort(compare) };
    return { ...member, health, packageDeclarationCoverage, dependencyDeclarationCoverage, diagnostics };
  });
  const sources = repositories.filter(m => !input.sourceRepositoryId || input.sourceRepositoryId === m.repositoryId);
  const targets = repositories.filter(m => !input.targetRepositoryId || input.targetRepositoryId === m.repositoryId);
  type Target = { member: typeof repositories[number]; package: PackageDeclaration };
  const packages: Target[] = [], buckets = new Map<string, Target[]>();
  for (const member of targets) {
    const pkg = inputs.get(member.repositoryId)?.package;
    if (!pkg || (input.packageName !== undefined && pkg.name !== input.packageName)) continue;
    const target = { member, package: pkg }; packages.push(target);
    const bucket = buckets.get(pkg.name) ?? []; bucket.push(target); buckets.set(pkg.name, bucket);
  }
  packages.sort((a,b) => compare(a.member.repositoryId,b.member.repositoryId) || compare(a.package.name,b.package.name));
  for (const bucket of buckets.values()) bucket.sort((a,b) => compare(a.member.repositoryId,b.member.repositoryId));
  const dependencies = sources.flatMap(member => (inputs.get(member.repositoryId)?.dependencies ?? []).filter(d =>
    input.packageName === undefined || d.declaredName === input.packageName).map(dependency => ({ member, dependency })));
  dependencies.sort((a,b) => compare(a.member.repositoryId,b.member.repositoryId) || compare(a.dependency.kind,b.dependency.kind)
    || compare(a.dependency.targetPackageName ?? a.dependency.declaredName,b.dependency.targetPackageName ?? b.dependency.declaredName)
    || compare(a.dependency.rawSpec ?? "",b.dependency.rawSpec ?? "") || compare(a.dependency.declaredName,b.dependency.declaredName));
  const links: WorkspacePackageLink[] = [], dependencyDeclarations: PackageDependencyRecord[] = [], packageDeclarations: PackageDeclaration[] = [];
  let returned = 0, returnedBytes = 0, knownLinks = 0, knownUnmatched = 0, joinComplete = true, outputBudgetComplete = true;
  const emit = <T>(array: T[], bytes: number, make: () => T, member: typeof repositories[number]) => {
    if (returned >= limit || !outputBudgetComplete) return;
    try {
      if (member.queryCoverage.inspectedRecords >= WORKSPACE_BOUNDS.maxRecordsPerRepository) throw new Error("record_budget_exceeded");
      reserveWorkspaceRead(budget, 1, bytes); member.queryCoverage.inspectedRecords++;
    } catch { outputBudgetComplete = false; return; }
    // Reserve bounded projected work/bytes before creating any link detail.
    const item = make();
    array.push(item); returned++; returnedBytes += Buffer.byteLength(JSON.stringify(item));
  };
  const records: PackageDependencyRecord[] = [];
  for (const { member, dependency } of dependencies) {
    try { checkWorkspaceDeadline(budget); } catch { joinComplete = false; break; }
    const bucket = dependency.supported ? buckets.get(dependency.targetPackageName!) : undefined;
    // At most one root declaration per repository: count exact bucket fan-out without pair hydration.
    const count = (bucket?.length ?? 0) - (bucket?.some(t => t.member.repositoryId === member.repositoryId) ? 1 : 0);
    const targetComplete = targets.every(t => t.repositoryId === member.repositoryId || complete(t.packageDeclarationCoverage));
    try {
      if (count > WORKSPACE_BOUNDS.maxRecordsPerRepository - member.queryCoverage.inspectedRecords) throw new Error("record_budget_exceeded");
      reserveWorkspaceRead(budget, count, 0); member.queryCoverage.inspectedRecords += count;
    } catch { joinComplete = false; break; }
    knownLinks += count;
    const unmatched = dependency.supported && count === 0 && targetComplete;
    if (unmatched) knownUnmatched++;
    const source = { repositoryId: member.repositoryId, generationId: member.generationId!, path: member.path,
      ...(inputs.get(member.repositoryId)?.package ? { package: inputs.get(member.repositoryId)!.package } : {}), dependency };
    records.push({ source, status: !dependency.supported ? "unresolved" : count ? "candidate" : unmatched ? "unmatched" : "unresolved",
      cardinality: count > 1 ? "many" : !dependency.supported || !targetComplete ? "unknown" : count === 1 ? "one" : "none",
      ...(!dependency.supported ? { reason: dependency.reason } : !targetComplete ? { reason: "target_coverage_incomplete" } : {}) });
    for (const target of bucket ?? []) {
      if (returned >= limit || !outputBudgetComplete) break;
      if (target.member.repositoryId === member.repositoryId) continue;
      const projectedBytes = Buffer.byteLength(JSON.stringify(source)) + Buffer.byteLength(JSON.stringify(target.package))
        + Buffer.byteLength(JSON.stringify([target.member.repositoryId,target.member.generationId,target.member.path])) + 512;
      emit(links, projectedBytes, () => ({ source, target: { repositoryId: target.member.repositoryId, generationId: target.member.generationId!,
        path: target.member.path, package: target.package }, relation: { kind: "declared_dependency_candidate", scope: "workspace_cross_repo", nameMatch: "exact" } }), member);
    }
  }
  for (const record of records) {
    if (returned >= limit || !outputBudgetComplete) break;
    emit(dependencyDeclarations,Buffer.byteLength(JSON.stringify(record)),() => record,repositories.find(m => m.repositoryId === record.source.repositoryId)!);
  }
  for (const pkg of packages) {
    if (returned >= limit || !outputBudgetComplete) break;
    emit(packageDeclarations,Buffer.byteLength(JSON.stringify(pkg.package)),() => pkg.package,pkg.member);
  }
  const allDiagnostics = repositories.flatMap(m => m.diagnostics).sort((a,b) => compare(a.repositoryId,b.repositoryId) || compare(a.role,b.role) || compare(a.code,b.code) || compare(JSON.stringify(a.ref ?? {}),JSON.stringify(b.ref ?? {})));
  const diagnostics: PackageDiagnostic[] = [];
  for (const diagnostic of allDiagnostics) {
    if (returned >= limit || !outputBudgetComplete) break;
    emit(diagnostics,Buffer.byteLength(JSON.stringify(diagnostic)),() => diagnostic,repositories.find(m => m.repositoryId === diagnostic.repositoryId)!);
  }
  const sourceComplete = sources.every(m => complete(m.dependencyDeclarationCoverage)), targetComplete = targets.every(m => complete(m.packageDeclarationCoverage));
  const scanComplete = sourceComplete && targetComplete && joinComplete;
  const count = (known: number, actual: number, exact: boolean) => exact ? exactProjectionCount(known,actual)
    : { total: null, returned: actual, omitted: null, truncated: known > actual, knownInspected: exactProjectionCount(known,actual) };
  const supported = dependencies.filter(d => d.dependency.supported).length, unresolved = dependencies.length - supported;
  const unavailable = repositories.filter(m => m.health.availability === "unavailable").length;
  const truncated = !outputBudgetComplete || links.length < knownLinks || dependencyDeclarations.length < dependencies.length || packageDeclarations.length < packages.length || diagnostics.length < allDiagnostics.length;
  return { workspace: selected.workspace, repositories, generationVector: repositories.map(m => ({ repositoryId: m.repositoryId, generationId: m.generationId })),
    links, dependencyDeclarations, packageDeclarations, diagnostics,
    counts: { repositories: exactProjectionCount(repositories.length,repositories.length),
      packageDeclarations: count(packages.length,packageDeclarations.length,targetComplete),
      dependencyDeclarations: count(dependencies.length,dependencyDeclarations.length,sourceComplete),
      supportedSpecs: count(supported,dependencyDeclarations.filter(d => d.source.dependency.supported).length,sourceComplete),
      unresolvedSpecs: count(unresolved,dependencyDeclarations.filter(d => !d.source.dependency.supported).length,sourceComplete),
      candidateLinks: count(knownLinks,links.length,scanComplete),
      unmatchedDependencies: count(knownUnmatched,dependencyDeclarations.filter(d => d.status === "unmatched").length,scanComplete),
      unavailableRepositories: exactProjectionCount(unavailable,unavailable), diagnostics: count(allDiagnostics.length,diagnostics.length,scanComplete) },
    scanComplete, truncated, limit, detail: input.detail ?? "compact",
    anyUnavailable: unavailable > 0, anyUnknownFreshness: repositories.some(m => m.evidenceState.freshness === "unknown"),
    mayBeIncomplete: !scanComplete || truncated || allDiagnostics.length > 0 || repositories.some(m => m.evidenceState.mayBeIncomplete),
    runtimeLimitation: WORKSPACE_PACKAGE_LIMITATION, consistency: WORKSPACE_CONSISTENCY,
    absenceStatement: "No known candidate proves absence only when every relevant indexed target role is complete; missing root evidence is not certified physical absence.",
    work: { inspectedRecords: budget.inspectedRecords, materializedBytes: budget.materializedBytes, returnedBytes, joinComplete, outputBudgetComplete } };
}
