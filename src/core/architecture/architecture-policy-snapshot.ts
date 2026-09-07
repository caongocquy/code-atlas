import { createHash } from "node:crypto";

import type { GraphDeltaContext } from "../change/graph-delta.service.js";
import {
  loadCodeAtlasConfigSnapshots,
  type CodeAtlasConfigSource,
  type CodeAtlasConfigSourceKind,
} from "../config/codeatlas-config-snapshot.js";
import {
  defaultArchitecturePolicy,
  parseArchitecturePolicy,
  type ArchitecturePolicy,
} from "./architecture-policy.js";

export type ArchitecturePolicySourceKind = CodeAtlasConfigSourceKind;

export type ArchitecturePolicySnapshot = {
  configured: boolean;
  source: {
    path: string;
    kind: ArchitecturePolicySourceKind;
    revision?: string;
  };
  policy: ArchitecturePolicy;
  semanticHash: string;
};

export type ArchitecturePolicyPair = {
  baseline: ArchitecturePolicySnapshot;
  target: ArchitecturePolicySnapshot;
  fileChanged: boolean;
  semanticChanged: boolean;
  changeKind: "unchanged" | "added" | "removed" | "modified";
  path: string;
};

function stable(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function groupKey(include: string[], exclude: string[]): string {
  return stable({ include: [...include].sort(), exclude: [...exclude].sort() });
}

function behaviorObject(policy: ArchitecturePolicy): unknown {
  const groupKeys = new Map(policy.groups.map((group) => [group.id, groupKey(group.include, group.exclude)]));
  // Keep matcher multiplicity: duplicate matching groups change classification to ambiguous.
  const groups = policy.groups.map((group) => groupKey(group.include, group.exclude)).sort();
  const rules = policy.rules.map((rule) => ({
    from: groupKeys.get(rule.from),
    to: groupKeys.get(rule.to),
    action: rule.action,
    edgeKinds: [...rule.edgeKinds].sort(),
  })).sort((left, right) => stable(left).localeCompare(stable(right)));
  return {
    groups,
    rules,
    defaultCrossGroupAction: policy.defaultCrossGroupAction,
    requireClassification: policy.requireClassification,
    cyclesEnabled: policy.cyclesEnabled,
  };
}

export function architecturePolicySemanticHash(policy: ArchitecturePolicy): string {
  return createHash("sha256").update(stable(behaviorObject(policy))).digest("hex");
}

export function architecturePoliciesEquivalent(left: ArchitecturePolicy, right: ArchitecturePolicy): boolean {
  return architecturePolicySemanticHash(left) === architecturePolicySemanticHash(right);
}

function snapshot(
  config: CodeAtlasConfigSource,
  side: "baseline" | "target",
): ArchitecturePolicySnapshot {
  if (!config.content) {
    const policy = defaultArchitecturePolicy();
    return {
      configured: false,
      source: config.source,
      policy,
      semanticHash: architecturePolicySemanticHash(policy),
    };
  }
  try {
    const policy = parseArchitecturePolicy(JSON.parse(config.content.toString("utf8")), config.source.path);
    return {
      configured: true,
      source: config.source,
      policy,
      semanticHash: architecturePolicySemanticHash(policy),
    };
  } catch (error) {
    const revision = config.source.revision ? `:${config.source.revision}` : "";
    const label = `${config.source.kind}${revision}:${config.source.path}`;
    throw new Error(`Invalid ${side} architecture policy at ${label}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

export async function loadArchitecturePolicySnapshots(
  repoPath: string,
  context: GraphDeltaContext,
  explicitPath?: string,
): Promise<ArchitecturePolicyPair> {
  const configs = await loadCodeAtlasConfigSnapshots(repoPath, context, explicitPath);
  const baseline = snapshot(configs.baseline, "baseline");
  const target = snapshot(configs.target, "target");
  return {
    baseline,
    target,
    fileChanged: configs.fileChanged,
    semanticChanged: baseline.semanticHash !== target.semanticHash,
    changeKind: configs.changeKind,
    path: configs.path,
  };
}
