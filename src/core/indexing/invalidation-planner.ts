import type {
  FileFactBinding,
  IndexVersionDomains,
  ParsedFactsBlob,
} from "../facts/facts.types.js";
import {
  importFactTargets,
  isRelativeImport,
  resolveImportCandidates,
  type ImportReference,
} from "../graph/imports.js";
import type { SupportedLanguage } from "../graph/parsers/types.js";
import type {
  InvalidationReasonCode,
  ResolutionScope,
  ResolutionScopeReason,
} from "./indexing.types.js";

export type InvalidationInput = {
  repositoryFiles: string[];
  currentFiles: Map<string, { contentHash: string; language: SupportedLanguage }>;
  previousBindings: Map<string, FileFactBinding>;
  directImporters: Map<string, Set<string>>;
  versions: IndexVersionDomains;
  previousVersions?: IndexVersionDomains;
};

export type DependencyImpact = "bounded" | "uncertain";

export type InvalidationPlan = {
  parsePaths: string[];
  reusePaths: string[];
  resolvePaths: string[];
  removedPaths: string[];
  derivedRebuild: boolean;
  fullGraphResolution: boolean;
  dependencyImpact: DependencyImpact;
  importersInvalidated: string[];
  reasons: InvalidationReasonCode[];
};

const REPOSITORY_RESOLUTION_REASONS = new Set<InvalidationReasonCode>([
  "unresolved_import_ownership",
  "path_moved",
  "path_renamed",
  "module_config_changed",
  "export_ambiguous",
  "dependency_provenance_incomplete",
  "facts_version_changed",
  "resolution_version_changed",
]);

export function requiresRepositoryResolution(plan: InvalidationPlan): boolean {
  return plan.fullGraphResolution || plan.reasons.some((reason) => REPOSITORY_RESOLUTION_REASONS.has(reason));
}

function assertNever(value: never): never {
  throw new Error(`unhandled invalidation reason: ${String(value)}`);
}

export function toResolutionScopeReason(reason: InvalidationReasonCode): ResolutionScopeReason {
  switch (reason) {
    case "source_changed": return "changed_source";
    case "direct_importer": return "direct_importer";
    case "resolution_version_changed": return "resolution_version";
    case "unresolved_import_ownership": return "uncertain_importer";
    case "path_moved": return "module_move";
    case "path_renamed": return "module_rename";
    case "module_config_changed": return "module_config";
    case "export_ambiguous": return "export_ambiguity";
    case "dependency_provenance_incomplete": return "incomplete_provenance";
    case "facts_version_changed": return "facts_change";
    default: return assertNever(reason);
  }
}

export function createResolutionScope(plan: InvalidationPlan): ResolutionScope {
  const reasons = [...new Set(plan.reasons.map(toResolutionScopeReason))].sort();
  const paths = [...new Set(plan.resolvePaths)].sort();
  return { mode: requiresRepositoryResolution(plan) ? "repository" : "bounded", paths, reasons };
}

const sorted = (paths: Iterable<string>): string[] => [...new Set(paths)].sort();

function factsInvalidated(
  versions: IndexVersionDomains,
  previousVersions: IndexVersionDomains | undefined,
): boolean {
  return previousVersions !== undefined && (
    versions.schemaVersion !== previousVersions.schemaVersion
    || versions.factsVersion !== previousVersions.factsVersion
  );
}

function resolutionInvalidated(
  versions: IndexVersionDomains,
  previousVersions: IndexVersionDomains | undefined,
): boolean {
  return previousVersions !== undefined
    && versions.resolutionVersion !== previousVersions.resolutionVersion;
}

function derivedInvalidated(
  versions: IndexVersionDomains,
  previousVersions: IndexVersionDomains | undefined,
): boolean {
  return previousVersions !== undefined
    && versions.derivedVersion !== previousVersions.derivedVersion;
}

function compatibleBinding(
  binding: FileFactBinding | undefined,
  current: { contentHash: string; language: SupportedLanguage },
): boolean {
  return binding?.contentHash === current.contentHash && binding.language === current.language;
}

function hasUncertainImporterEvidence(directImporters: Map<string, Set<string>>): boolean {
  return [...directImporters.keys()].some((target) =>
    target === "*" || target.startsWith("module:") || target.startsWith("unresolved:"),
  );
}

export function planInvalidation(input: InvalidationInput): InvalidationPlan {
  const repositoryFiles = sorted(input.repositoryFiles);
  const repositoryFileSet = new Set(repositoryFiles);
  const currentPaths = sorted(input.currentFiles.keys());
  const currentPathSet = new Set(currentPaths);
  const previousPaths = sorted(input.previousBindings.keys());
  const removedPaths = previousPaths.filter((file) => !currentPathSet.has(file));
  const factsChanged = factsInvalidated(input.versions, input.previousVersions);
  const resolutionChanged = resolutionInvalidated(input.versions, input.previousVersions);
  const derivedChanged = derivedInvalidated(input.versions, input.previousVersions);
  const parsePaths: string[] = [];
  const reusePaths: string[] = [];
  const changedPaths: string[] = [];
  const renamedPaths = new Set<string>();

  for (const file of currentPaths) {
    const current = input.currentFiles.get(file);
    if (!current) continue;

    if (factsChanged) {
      parsePaths.push(file);
      changedPaths.push(file);
      continue;
    }

    const previous = input.previousBindings.get(file);
    if (compatibleBinding(previous, current)) {
      reusePaths.push(file);
      continue;
    }

    const contentMatch = previousPaths.some((oldPath) =>
      oldPath !== file && compatibleBinding(input.previousBindings.get(oldPath), current),
    );
    if (contentMatch) {
      reusePaths.push(file);
      renamedPaths.add(file);
    } else {
      parsePaths.push(file);
    }
    changedPaths.push(file);
  }

  const directChanges = new Set([...changedPaths, ...removedPaths]);
  const importersInvalidated = sorted(
    [...directChanges].flatMap((target) => [...(input.directImporters.get(target) ?? [])])
      .filter((file) => currentPathSet.has(file)),
  );
  const hasRepositoryChange = directChanges.size > 0;
  const dependencyImpact: DependencyImpact = hasRepositoryChange && hasUncertainImporterEvidence(input.directImporters)
    ? "uncertain"
    : "bounded";
  const fullGraphResolution = resolutionChanged || dependencyImpact === "uncertain";
  const resolvePaths = fullGraphResolution
    ? repositoryFiles.filter((file) => currentPathSet.has(file))
    : sorted([
      ...changedPaths.filter((file) => currentPathSet.has(file)),
      ...importersInvalidated,
    ]);

  const reasons: InvalidationReasonCode[] = [];
  if (parsePaths.length > 0 && !factsChanged) reasons.push("source_changed");
  if (importersInvalidated.length > 0) reasons.push("direct_importer");
  if (resolutionChanged) reasons.push("resolution_version_changed");
  if (dependencyImpact === "uncertain") reasons.push("unresolved_import_ownership");
  if (renamedPaths.size > 0) reasons.push("path_renamed");
  if (removedPaths.length > renamedPaths.size) reasons.push("path_moved");
  if (factsChanged) reasons.push("facts_version_changed");

  return {
    parsePaths: sorted(parsePaths),
    reusePaths: sorted(reusePaths.filter((file) => repositoryFileSet.has(file))),
    resolvePaths,
    removedPaths,
    derivedRebuild: derivedChanged,
    fullGraphResolution,
    dependencyImpact,
    importersInvalidated,
    reasons,
  };
}

export function buildReverseImporterIndex(
  imports: Map<string, ImportReference[]>,
): Map<string, Set<string>> {
  const reverse = new Map<string, Set<string>>();
  const importers = sorted(imports.keys());

  for (const importer of importers) {
    const references = [...(imports.get(importer) ?? [])]
      .sort((left, right) => left.source.localeCompare(right.source));
    for (const reference of references) {
      const targets = isRelativeImport(reference.source)
        ? resolveImportCandidates(importer, reference.source)
        : [`module:${reference.source}`];
      for (const target of sorted(targets)) {
        const importerSet = reverse.get(target) ?? new Set<string>();
        importerSet.add(importer);
        reverse.set(target, importerSet);
      }
    }
  }

  return new Map(
    [...reverse.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([target, importerSet]) => [target, new Set(sorted(importerSet))]),
  );
}

export function buildFactReverseImporterIndex(
  inputs: ReadonlyMap<string, ParsedFactsBlob>,
): ReadonlyMap<string, ReadonlySet<string>> {
  const reverse = new Map<string, Set<string>>();

  for (const [importer, facts] of [...inputs.entries()].sort(([left], [right]) => left.localeCompare(right))) {
    for (const fact of facts.imports) {
      for (const target of importFactTargets(importer, fact)) {
        const importers = reverse.get(target) ?? new Set<string>();
        importers.add(importer);
        reverse.set(target, importers);
      }
    }
  }

  return new Map(
    [...reverse.entries()]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([target, importers]) => [target, new Set(sorted(importers))]),
  );
}
