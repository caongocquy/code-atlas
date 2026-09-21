import { normalizeContributions } from "./reliability-normalize.js";
import { fromFrameworkEvidenceRef } from "./reliability-normalize.js";
import { reliabilityOwnerKey, reliabilityOutputKey, canonicalReliabilityScope } from "./reliability-identity.js";
import { frameworkEntityKey, frameworkSubjectKey } from "../framework/framework-identity.js";
import type { FrameworkMaterialization, FrameworkProvenance } from "../framework/framework.types.js";
import type { ReliabilityContribution } from "./reliability.types.js";

export interface ReliabilityPathContract {
  allMaterializedPaths: readonly string[];
  analysisPaths: readonly string[];
  deletedPaths: readonly string[];
  dependencyAffectedPaths: readonly string[];
}

function affectedPaths(input: ReliabilityPathContract): ReadonlySet<string> {
  return new Set([...input.analysisPaths, ...input.deletedPaths, ...input.dependencyAffectedPaths]);
}

function contributionOwnedBy(contribution: ReliabilityContribution, paths: ReadonlySet<string>): boolean {
  return contribution.evidence.some((evidence) => evidence.sourcePath !== undefined && paths.has(evidence.sourcePath));
}

export function materializeReliabilityIncremental(
  previous: readonly ReliabilityContribution[],
  paths: ReliabilityPathContract,
  recomputed: readonly ReliabilityContribution[],
): readonly ReliabilityContribution[] {
  const affected = affectedPaths(paths);
  const reused = previous.filter((contribution) => !contributionOwnedBy(contribution, affected));
  return normalizeContributions([...reused, ...recomputed]);
}

function contributionsForOutput(
  provenance: FrameworkProvenance,
  outputKind: "entity" | "relationship" | "classification",
  outputKey: string,
): ReliabilityContribution[] {
  const scope = canonicalReliabilityScope({
    capability: provenance.capability ?? "framework_output",
    outputKind,
    framework: provenance.framework,
  });
  return provenance.refs.map((ref) => {
    const ownerKey = reliabilityOwnerKey({
      sourcePath: ref.relativePath,
      inputKey: ref.inputKey,
      capability: provenance.capability,
      adapterId: provenance.adapterId,
    });
    return {
      ownerKey,
      scope,
      outputKey,
      outcome: "accepted" as const,
      complete: true,
      stale: false,
      origin: "framework_inferred" as const,
      evidence: [fromFrameworkEvidenceRef(ref, ownerKey)],
      diagnostics: [],
      coverage: { applicable: true, supported: true, attempted: true, resolved: true, ambiguous: false, unknown: false, unsupported: false, budgetExhausted: false },
    };
  });
}

export function frameworkMaterializationContributions(materialization: FrameworkMaterialization): readonly ReliabilityContribution[] {
  const contributions: ReliabilityContribution[] = [];
  for (const entity of materialization.entities) {
    contributions.push(...contributionsForOutput(entity.provenance, "entity", reliabilityOutputKey({ kind: "entity", entityKey: frameworkEntityKey(entity.ref) })));
  }
  for (const relationship of materialization.relationships) {
    contributions.push(...contributionsForOutput(relationship.provenance, "relationship", reliabilityOutputKey({
      kind: "relationship",
      sourceKey: frameworkSubjectKey(relationship.source),
      targetKey: frameworkSubjectKey(relationship.target),
      relationKind: relationship.relationKind,
    })));
  }
  for (const classification of materialization.classifications) {
    contributions.push(...contributionsForOutput(classification.provenance, "classification", reliabilityOutputKey({
      kind: "classification",
      subject: classification.subject.kind === "language"
        ? { kind: "language", nodeId: classification.subject.nodeId }
        : { kind: "framework", entityKey: frameworkEntityKey(classification.subject.entity) },
      classificationKind: classification.classificationKind,
    })));
  }
  return normalizeContributions(contributions);
}
