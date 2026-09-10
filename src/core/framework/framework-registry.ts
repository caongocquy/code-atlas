import type {
  DetectionResult, FrameworkAnalysisContext, FrameworkCanonicalization, FrameworkCanonicalRoute,
  FrameworkClassification, FrameworkDiagnostic, FrameworkEvidence, FrameworkMaterialization,
  FrameworkProvenance, FrameworkRelationship, FrameworkSemanticAdapter, FrameworkEvidenceRef,
  FrameworkEntity,
} from "./framework.types.js";
import { frameworkEntityKey, frameworkSubjectKey } from "./framework-identity.js";
import { reactNextAdapter } from "./adapters/react-next.js";

function sorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}
function refs(value: readonly FrameworkEvidenceRef[]): FrameworkEvidenceRef[] {
  return sorted(value, (ref) => JSON.stringify(ref));
}
function provenance(evidence: FrameworkEvidence): FrameworkProvenance {
  return { origin: "framework_inferred", framework: evidence.framework, adapterId: evidence.adapterId, adapterVersion: evidence.adapterVersion, strategy: evidence.strategy, confidence: evidence.confidence === "weak" ? "strong" : evidence.confidence, evidenceIds: [evidence.evidenceId], refs: refs(evidence.refs) };
}
function diagnostic(evidence: FrameworkEvidence, code: FrameworkDiagnostic["code"], outcome: FrameworkDiagnostic["outcome"], reason: string): FrameworkDiagnostic {
  return { code, outcome, framework: evidence.framework, capability: evidence.capability, relativePath: evidence.relativePath, strategy: evidence.strategy, evidenceIds: [evidence.evidenceId], refs: refs(evidence.refs), reason };
}

export function detectFrameworks(ctx: Parameters<FrameworkSemanticAdapter["detect"]>[0], adapters: readonly FrameworkSemanticAdapter[]): readonly DetectionResult[] {
  const results: DetectionResult[] = [];
  for (const adapter of sorted(adapters, (item) => item.id)) results.push(...adapter.detect(ctx));
  return sorted(results, (item) => `${item.framework}:${item.scope}`);
}

export function canonicalizeFrameworkEntity(input: FrameworkCanonicalRoute): FrameworkCanonicalization {
  const slash = (value: string): string => value.replaceAll("\\", "/");
  const scope = slash(input.scope);
  const router = slash(input.router);
  if (!scope || !router || scope.startsWith("/") || router.startsWith("/") || scope.split("/").includes("..") || router.split("/").includes("..")) return { kind: "unresolved", code: "framework_construct_unsupported", reason: "route scope or router is not canonical" };
  const conditions = [...new Set(input.conditions)].sort();
  if (conditions.some((condition) => condition.length === 0 || condition.includes("\0"))) return { kind: "unresolved", code: "framework_construct_unsupported", reason: "route conditions are not canonical" };
  const logicalKey = JSON.stringify([scope, router, input.path, input.method === null ? null : input.method.toUpperCase(), conditions, input.owner]);
  try {
    const ref = { framework: input.framework, kind: input.kind, logicalKey } as const;
    frameworkEntityKey(ref);
    return { kind: "canonical", ref };
  } catch {
    return { kind: "unresolved", code: "framework_construct_unsupported", reason: "route identity is not canonical" };
  }
}

export function resolveFrameworkEvidence(ctx: FrameworkAnalysisContext, evidence: readonly FrameworkEvidence[]): FrameworkMaterialization {
  const entities = new Map<string, FrameworkEntity>();
  const relationships = new Map<string, FrameworkRelationship>();
  const classifications = new Map<string, FrameworkClassification>();
  const diagnostics: FrameworkDiagnostic[] = [];
  const coverage = new Map<string, FrameworkMaterialization["coverage"][number]>();
  for (const item of sorted(evidence, (value) => value.evidenceId)) {
    const accepted = item.confidence === "exact" || item.confidence === "strong";
    const coverageKey = `${item.framework}:${item.capability}:${item.relativePath}:${item.strategy}:${item.outputKind}`;
    const dimension = coverage.get(coverageKey) ?? (item.outputKind === "relationship"
      ? { framework: item.framework, capability: item.capability, relativePath: item.relativePath, strategy: item.strategy, outputKind: item.outputKind, kind: item.relationKind, applicable: item.applicable ? 1 : 0, supported: item.supported ? 1 : 0, attempted: item.attempted ? 1 : 0, resolved: 0, ambiguous: 0, unknown: 0, unsupported: 0, budgetExhausted: 0, weakDropped: 0 }
      : { framework: item.framework, capability: item.capability, relativePath: item.relativePath, strategy: item.strategy, outputKind: item.outputKind, kind: item.classificationKind, applicable: item.applicable ? 1 : 0, supported: item.supported ? 1 : 0, attempted: item.attempted ? 1 : 0, resolved: 0, ambiguous: 0, unknown: 0, unsupported: 0, budgetExhausted: 0, weakDropped: 0 });
    if (!accepted) {
      dimension.weakDropped += 1;
      dimension.unsupported += 1;
      diagnostics.push(diagnostic(item, "framework_construct_unsupported", "unsupported", "weak_evidence_dropped"));
      coverage.set(coverageKey, dimension);
      continue;
    }
    for (const observation of item.entities) {
      if (observation.confidence === "weak") continue;
      const entity: FrameworkEntity = { ref: observation.ref, displayName: observation.displayName, provenance: provenance(item) };
      const key = frameworkEntityKey(entity.ref);
      const existing = entities.get(key);
      if (existing && JSON.stringify(existing) !== JSON.stringify(entity)) diagnostics.push(diagnostic(item, "framework_entity_identity_collision", "ambiguous", "conflicting entity declarations"));
      else if (!existing) entities.set(key, entity);
    }
    if (item.outputKind === "relationship") {
      if (item.sourceCandidates.length !== 1 || item.targetCandidates.length !== 1) {
        const unknown = item.sourceCandidates.length === 0 || item.targetCandidates.length === 0;
        dimension[unknown ? "unknown" : "ambiguous"] += 1;
        diagnostics.push(diagnostic(item, unknown ? "framework_target_unknown" : "framework_target_ambiguous", unknown ? "unknown" : "ambiguous", "relationship endpoint is not unique"));
      } else {
        const relationship: FrameworkRelationship = { outputKind: "relationship", source: item.sourceCandidates[0]!, target: item.targetCandidates[0]!, relationKind: item.relationKind, provenance: provenance(item) };
        relationships.set(JSON.stringify([frameworkSubjectKey(relationship.source), frameworkSubjectKey(relationship.target), relationship.relationKind]), relationship);
        dimension.resolved += 1;
      }
    } else if (item.subjectCandidates.length !== 1 || item.values.length !== 1) {
      const unknown = item.subjectCandidates.length === 0 || item.values.length === 0;
      dimension[unknown ? "unknown" : "ambiguous"] += 1;
      diagnostics.push(diagnostic(item, unknown ? "framework_subject_unknown" : "framework_classification_conflict", unknown ? "unknown" : "ambiguous", "classification subject or value is not unique"));
    } else {
      const classification: FrameworkClassification = { outputKind: "classification", subject: item.subjectCandidates[0]!, classificationKind: item.classificationKind, classificationValue: item.values[0]!, provenance: provenance(item) };
      const key = JSON.stringify([frameworkSubjectKey(classification.subject), classification.classificationKind]);
      const existing = classifications.get(key);
      if (existing && existing.classificationValue !== classification.classificationValue) {
        diagnostics.push(diagnostic(item, "framework_classification_conflict", "ambiguous", "classification values conflict"));
        dimension.ambiguous += 1;
      } else {
        classifications.set(key, classification);
        dimension.resolved += 1;
      }
    }
    coverage.set(coverageKey, dimension);
  }
  return { frameworkResolutionVersion: ctx.frameworkResolutionVersion, entities: sorted([...entities.values()], (item) => frameworkEntityKey(item.ref)), relationships: sorted([...relationships.values()], (item) => JSON.stringify([frameworkSubjectKey(item.source), frameworkSubjectKey(item.target), item.relationKind])), classifications: sorted([...classifications.values()], (item) => JSON.stringify([frameworkSubjectKey(item.subject), item.classificationKind])), diagnostics: sorted(diagnostics, (item) => JSON.stringify([item.code, item.relativePath, item.strategy, item.reason])), coverage: sorted([...coverage.values()], (item) => `${item.framework}:${item.capability}:${item.relativePath}:${item.strategy}:${item.outputKind}:${item.kind}`), config: ctx.config, detections: ctx.detections, dependencies: [], complete: true };
}

export function analyzeFramework(ctx: FrameworkAnalysisContext, adapters: readonly FrameworkSemanticAdapter[]): FrameworkMaterialization {
  const evidence: FrameworkEvidence[] = [];
  const diagnostics: FrameworkDiagnostic[] = [];
  for (const adapter of sorted(adapters, (item) => item.id)) {
    try {
      const result = adapter.analyze(ctx);
      evidence.push(...result.evidence.slice(0, Math.max(0, ctx.maxObservations)));
    } catch (error) {
      diagnostics.push({ code: "framework_adapter_failed", outcome: "adapter_failed", framework: adapter.frameworks[0] ?? "react", capability: "adapter", relativePath: "", strategy: adapter.id, evidenceIds: [], refs: [], reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const materialized = resolveFrameworkEvidence(ctx, evidence);
  return { ...materialized, diagnostics: [...materialized.diagnostics, ...diagnostics].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))) };
}

export const builtinFrameworkAdapters: readonly FrameworkSemanticAdapter[] = [reactNextAdapter];
