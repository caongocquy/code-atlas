import type { FrameworkSnapshot } from "./framework.types.js";

export interface FrameworkInvalidationInput {
  /** Paths whose facts/config/lookup state changed; allPaths is the rebuild universe. */
  paths: readonly string[];
  allPaths: readonly string[];
  changedInputKeys: ReadonlySet<string>;
  changedLookupKeys: ReadonlySet<string>;
  previous?: FrameworkSnapshot;
  frameworkResolutionVersion: string;
  topologyComplete: boolean;
}

export interface FrameworkInvalidationPlan {
  analyzePaths: readonly string[];
  reusePaths: readonly string[];
  widened: boolean;
  reasons: readonly string[];
}

const sorted = (values: Iterable<string>): string[] => [...new Set(values)].sort();

export function planFrameworkInvalidation(input: FrameworkInvalidationInput): FrameworkInvalidationPlan {
  const changedPaths = sorted(input.paths);
  const paths = sorted(input.allPaths);
  const previous = input.previous;
  const reasons: string[] = [];
  if (!previous) reasons.push("missing_framework_snapshot");
  if (previous?.frameworkResolutionVersion !== input.frameworkResolutionVersion) reasons.push("framework_resolution_version_changed");
  if (!input.topologyComplete) reasons.push("framework_topology_incomplete");

  const changedOwners = new Set<string>();
  for (const dependency of previous?.dependencies ?? []) {
    const inputChanged = dependency.inputKeys.some((key) => input.changedInputKeys.has(key));
    const lookupChanged = dependency.lookupKeys.some((key) => input.changedLookupKeys.has(key));
    if (inputChanged || lookupChanged || changedPaths.includes(dependency.ownerPath)) changedOwners.add(dependency.ownerPath);
  }
  if (changedOwners.size > 0) reasons.push("framework_dependency_changed");

  const widened = reasons.some((reason) => reason !== "framework_dependency_changed");
  const analyzePaths = widened ? paths : sorted([...changedPaths, ...changedOwners]);
  const analyzeSet = new Set(analyzePaths);
  return {
    analyzePaths,
    reusePaths: paths.filter((path) => !analyzeSet.has(path)),
    widened,
    reasons: [...new Set(reasons)].sort(),
  };
}
