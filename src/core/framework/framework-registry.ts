import type {
  DetectionResult, FrameworkAnalysisContext, FrameworkCanonicalization, FrameworkCanonicalRoute,
  FrameworkClassification, FrameworkDiagnostic, FrameworkEvidence, FrameworkMaterialization,
  FrameworkProvenance, FrameworkRelationship, FrameworkSemanticAdapter, FrameworkEvidenceRef,
  FrameworkEntity, FrameworkSnapshot,
} from "./framework.types.js";
import { frameworkEntityKey, frameworkSubjectKey } from "./framework-identity.js";
import { reactNextAdapter } from "./adapters/react-next.js";
import { nestjsAdapter } from "./adapters/nestjs.js";
import { springAdapter } from "./adapters/spring.js";
import { flutterAdapter } from "./adapters/flutter.js";

function sorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}
function uniqueSorted<T>(values: readonly T[], key: (value: T) => string): T[] {
  const unique = new Map<string, T>();
  for (const value of values) unique.set(key(value), value);
  return sorted([...unique.values()], key);
}
function refs(value: readonly FrameworkEvidenceRef[]): FrameworkEvidenceRef[] {
  return sorted(value, (ref) => JSON.stringify(ref));
}
function provenance(evidence: FrameworkEvidence): FrameworkProvenance {
  return { origin: "framework_inferred", framework: evidence.framework, capability: evidence.capability, adapterId: evidence.adapterId, adapterVersion: evidence.adapterVersion, strategy: evidence.strategy, confidence: evidence.confidence === "weak" ? "strong" : evidence.confidence, evidenceIds: [evidence.evidenceId], refs: refs(evidence.refs) };
}
function diagnostic(evidence: FrameworkEvidence, code: FrameworkDiagnostic["code"], outcome: FrameworkDiagnostic["outcome"], reason: string): FrameworkDiagnostic {
  return { code, outcome, framework: evidence.framework, capability: evidence.capability, relativePath: evidence.relativePath, strategy: evidence.strategy, evidenceIds: [evidence.evidenceId], refs: refs(evidence.refs), reason };
}

function ownerPaths(value: { refs: readonly FrameworkEvidenceRef[] }): Set<string> {
  return new Set(value.refs.map((ref) => ref.relativePath));
}

function contributesTo(value: { refs: readonly FrameworkEvidenceRef[] }, paths: ReadonlySet<string>): boolean {
  return [...ownerPaths(value)].some((path) => paths.has(path));
}

function subjectExists(ctx: FrameworkAnalysisContext, subject: FrameworkRelationship["source"], entityKeys: ReadonlySet<string>): boolean {
  return subject.kind === "language"
    ? ctx.graph.nodes.some((node) => node.id === subject.nodeId)
    : entityKeys.has(frameworkEntityKey(subject.entity));
}

function mergeProvenance(left: FrameworkProvenance, right: FrameworkProvenance): FrameworkProvenance | undefined {
  if (left.origin !== right.origin || (left.capability !== undefined && right.capability !== undefined && left.capability !== right.capability) || left.adapterId !== right.adapterId || left.adapterVersion !== right.adapterVersion || left.strategy !== right.strategy) return undefined;
  const evidenceIds = [...new Set([...left.evidenceIds, ...right.evidenceIds])].sort();
  const mergedRefs = refs([...left.refs, ...right.refs].filter((ref, index, all) => all.findIndex((item) => JSON.stringify(item) === JSON.stringify(ref)) === index));
  if (evidenceIds.length > 32 || mergedRefs.length > 32 || evidenceIds.some((id) => id.length > 256) || mergedRefs.some((ref) => ref.relativePath.length > 1024 || JSON.stringify(ref).length > 2048) || JSON.stringify({ ...left, evidenceIds, refs: mergedRefs }).length > 128 * 1024) return undefined;
  return {
    ...left,
    ...(left.capability || right.capability ? { capability: left.capability ?? right.capability } : {}),
    confidence: left.confidence === "exact" && right.confidence === "exact" ? "exact" : "strong",
    evidenceIds,
    refs: mergedRefs,
  };
}

function hasIncompleteCoverage(coverage: readonly FrameworkMaterialization["coverage"][number][]): boolean {
  return coverage.some((item) => item.applicable > 0 && (
    item.supported < item.applicable
    || item.attempted < item.applicable
    || item.resolved + item.ambiguous + item.unknown + item.unsupported + item.budgetExhausted < item.attempted
    || item.ambiguous > 0
    || item.unknown > 0
    || item.unsupported > 0
    || item.budgetExhausted > 0
  ));
}

function hasIncompleteDetectionInputs(
  detections: readonly DetectionResult[],
  coverage: readonly FrameworkMaterialization["coverage"][number][],
): boolean {
  return detections.some((item) => {
    if (!item.complete || (item.configured && !item.observed) || !item.observed) return item.configured && !item.observed;
    return item.capabilities.length === 0
      ? !coverage.some((entry) => entry.framework === item.framework && entry.applicable > 0)
      : item.capabilities.some((capability) => !coverage.some((entry) => entry.framework === item.framework && entry.capability === capability && entry.applicable > 0));
  });
}

function contributorPaths(snapshot: FrameworkMaterialization, paths: ReadonlySet<string>): Set<string> {
  const result = new Set(paths);
  for (const output of [...snapshot.entities, ...snapshot.relationships, ...snapshot.classifications]) {
    if (contributesTo(output.provenance, paths)) for (const path of ownerPaths(output.provenance)) result.add(path);
  }
  for (const diagnostic of snapshot.diagnostics) if (diagnostic.refs.some((ref) => paths.has(ref.relativePath))) for (const ref of diagnostic.refs) result.add(ref.relativePath);
  return result;
}

export function expandFrameworkAnalyzePaths(previous: FrameworkSnapshot | undefined, paths: ReadonlySet<string>): ReadonlySet<string> {
  return previous ? contributorPaths(previous, paths) : paths;
}

export function detectFrameworks(ctx: Parameters<FrameworkSemanticAdapter["detect"]>[0], adapters: readonly FrameworkSemanticAdapter[]): readonly DetectionResult[] {
  const results: DetectionResult[] = [];
  for (const adapter of sorted(adapters, (item) => item.id)) results.push(...adapter.detect(ctx));
  return sorted(results, (item) => `${item.framework}:${item.scope}`);
}

export function canonicalizeFrameworkEntity(input: FrameworkCanonicalRoute): FrameworkCanonicalization {
  const scope = input.scope;
  const router = input.router;
  if (!scope || !router || scope.includes("\\") || router.includes("\\") || input.path.includes("\\") || input.path.includes("//") || input.path.split("/").some((segment) => segment === "." || segment === "..") || scope.startsWith("/") || router.startsWith("/") || scope.split("/").includes("..") || router.split("/").includes("..")) return { kind: "unresolved", code: "framework_construct_unsupported", reason: "route scope or router is not canonical" };
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
  const conflictingEntities = new Set<string>();
  const conflictingRelationships = new Set<string>();
  const conflictingClassifications = new Set<string>();
  const relationshipCoverageKeys = new Map<string, Set<string>>();
  const classificationCoverageKeys = new Map<string, Set<string>>();
  const entityCollisionCoverageKeys = new Map<string, Set<string>>();
  const entityCollisionEvidence = new Set<string>();
  const diagnostics: FrameworkDiagnostic[] = [];
  const coverage = new Map<string, FrameworkMaterialization["coverage"][number]>();
  const orderedEvidence = sorted(evidence, (value) => value.evidenceId);
  for (const item of orderedEvidence) {
    if (item.confidence !== "exact" && item.confidence !== "strong") continue;
    for (const observation of item.entities) {
      if (observation.confidence === "weak") continue;
      const entity: FrameworkEntity = { ref: observation.ref, displayName: observation.displayName, provenance: provenance(item) };
      const key = frameworkEntityKey(entity.ref);
      const existing = entities.get(key);
      if (conflictingEntities.has(key)) continue;
      if (!existing) entities.set(key, entity);
      else if (existing.displayName === entity.displayName) {
        const merged = mergeProvenance(existing.provenance, entity.provenance);
        if (merged) entities.set(key, { ...existing, provenance: merged });
        else {
          entities.delete(key);
          conflictingEntities.add(key);
          entityCollisionEvidence.add(item.evidenceId);
          diagnostics.push(diagnostic(item, "framework_entity_identity_collision", "ambiguous", "conflicting entity provenance"));
        }
      } else {
        entities.delete(key);
        conflictingEntities.add(key);
        entityCollisionEvidence.add(item.evidenceId);
        for (const evidenceId of existing.provenance.evidenceIds) entityCollisionEvidence.add(evidenceId);
        diagnostics.push(diagnostic(item, "framework_entity_identity_collision", "ambiguous", "conflicting entity declarations"));
      }
    }
  }
  const knownEntityKeys = new Set(entities.keys());
  for (const item of orderedEvidence) {
    const accepted = item.confidence === "exact" || item.confidence === "strong";
    const outputKind = item.outputKind === "relationship" ? item.relationKind : item.classificationKind;
    const coverageKey = JSON.stringify([item.framework, item.capability, item.relativePath, item.strategy, item.outputKind, outputKind]);
    const dimension = coverage.get(coverageKey) ?? (item.outputKind === "relationship"
      ? { framework: item.framework, capability: item.capability, relativePath: item.relativePath, strategy: item.strategy, outputKind: item.outputKind, kind: item.relationKind, applicable: item.applicable ? 1 : 0, supported: item.applicable && item.supported ? 1 : 0, attempted: item.applicable && item.attempted ? 1 : 0, resolved: 0, ambiguous: 0, unknown: 0, unsupported: 0, budgetExhausted: 0, weakDropped: 0 }
      : { framework: item.framework, capability: item.capability, relativePath: item.relativePath, strategy: item.strategy, outputKind: item.outputKind, kind: item.classificationKind, applicable: item.applicable ? 1 : 0, supported: item.applicable && item.supported ? 1 : 0, attempted: item.applicable && item.attempted ? 1 : 0, resolved: 0, ambiguous: 0, unknown: 0, unsupported: 0, budgetExhausted: 0, weakDropped: 0 });
    if (coverage.has(coverageKey)) {
      dimension.applicable += item.applicable ? 1 : 0;
      dimension.supported += item.applicable && item.supported ? 1 : 0;
      dimension.attempted += item.applicable && item.attempted ? 1 : 0;
    }
    if (!item.applicable) {
      coverage.set(coverageKey, dimension);
      continue;
    }
    if (item.state === "budget_exhausted") {
      dimension.budgetExhausted += 1;
      diagnostics.push(diagnostic(item, "framework_budget_exhausted", "budget_exhausted", "framework observation budget exhausted"));
      coverage.set(coverageKey, dimension);
      continue;
    }
    if (item.state === "unknown") {
      dimension.unknown += 1;
      diagnostics.push(diagnostic(item, item.outputKind === "relationship" ? "framework_target_unknown" : "framework_subject_unknown", "unknown", "framework observation is unresolved"));
      coverage.set(coverageKey, dimension);
      continue;
    }
    if (item.applicable && !item.attempted) {
      dimension.unknown += 1;
      diagnostics.push(diagnostic(item, item.outputKind === "relationship" ? "framework_target_unknown" : "framework_subject_unknown", "unknown", "framework observation was not attempted"));
      coverage.set(coverageKey, dimension);
      continue;
    }
    if (item.state === "unsupported" || !item.supported) {
      dimension.unsupported += 1;
      diagnostics.push(diagnostic(item, "framework_construct_unsupported", "unsupported", "framework construct is unsupported"));
      coverage.set(coverageKey, dimension);
      continue;
    }
    if (!accepted) {
      dimension.weakDropped += 1;
      dimension.unsupported += 1;
      diagnostics.push(diagnostic(item, "framework_construct_unsupported", "unsupported", "weak_evidence_dropped"));
      coverage.set(coverageKey, dimension);
      continue;
    }
    if (item.entities.some((observation) => conflictingEntities.has(frameworkEntityKey(observation.ref)))) {
      for (const observation of item.entities) {
        const entityKey = frameworkEntityKey(observation.ref);
        if (!conflictingEntities.has(entityKey) || !entityCollisionEvidence.has(item.evidenceId)) continue;
        if (!entityCollisionCoverageKeys.has(entityKey)) entityCollisionCoverageKeys.set(entityKey, new Set());
        entityCollisionCoverageKeys.get(entityKey)!.add(coverageKey);
      }
      coverage.set(coverageKey, dimension);
      continue;
    }
    if (item.outputKind === "relationship") {
      if (item.sourceCandidates.length !== 1 || item.targetCandidates.length !== 1) {
        const unknown = item.sourceCandidates.length === 0 || item.targetCandidates.length === 0;
        dimension[unknown ? "unknown" : "ambiguous"] += 1;
        diagnostics.push(diagnostic(item, unknown ? "framework_target_unknown" : "framework_target_ambiguous", unknown ? "unknown" : "ambiguous", "relationship endpoint is not unique"));
      } else {
        const relationship: FrameworkRelationship = { outputKind: "relationship", source: item.sourceCandidates[0]!, target: item.targetCandidates[0]!, relationKind: item.relationKind, provenance: provenance(item) };
        if (!subjectExists(ctx, relationship.source, knownEntityKeys) || !subjectExists(ctx, relationship.target, knownEntityKeys)) {
          dimension.unknown += 1;
          diagnostics.push(diagnostic(item, "framework_target_unknown", "unknown", "relationship endpoint is not present in the candidate universe"));
          coverage.set(coverageKey, dimension);
          continue;
        }
        const key = JSON.stringify([frameworkSubjectKey(relationship.source), frameworkSubjectKey(relationship.target), relationship.relationKind]);
        if (!relationshipCoverageKeys.has(key)) relationshipCoverageKeys.set(key, new Set());
        relationshipCoverageKeys.get(key)!.add(coverageKey);
        if (conflictingRelationships.has(key)) continue;
        const existing = relationships.get(key);
        const merged = existing ? mergeProvenance(existing.provenance, relationship.provenance) : relationship.provenance;
        if (merged) {
          relationships.set(key, existing ? { ...existing, provenance: merged } : relationship);
          if (!existing) dimension.resolved += 1;
        }
        else {
          relationships.delete(key);
          conflictingRelationships.add(key);
          diagnostics.push(diagnostic(item, "framework_target_ambiguous", "ambiguous", "conflicting relationship provenance"));
        }
      }
    } else if (item.subjectCandidates.length !== 1 || item.values.length !== 1) {
      const unknown = item.subjectCandidates.length === 0 || item.values.length === 0;
      dimension[unknown ? "unknown" : "ambiguous"] += 1;
      diagnostics.push(diagnostic(item, unknown ? "framework_subject_unknown" : item.subjectCandidates.length > 1 ? "framework_subject_ambiguous" : "framework_classification_conflict", unknown ? "unknown" : "ambiguous", "classification subject or value is not unique"));
    } else {
      const classification: FrameworkClassification = { outputKind: "classification", subject: item.subjectCandidates[0]!, classificationKind: item.classificationKind, classificationValue: item.values[0]!, provenance: provenance(item) };
      const key = JSON.stringify([frameworkSubjectKey(classification.subject), classification.classificationKind]);
      if (!classificationCoverageKeys.has(key)) classificationCoverageKeys.set(key, new Set());
      classificationCoverageKeys.get(key)!.add(coverageKey);
      const existing = classifications.get(key);
      if (conflictingClassifications.has(key)) continue;
      if (existing && existing.classificationValue !== classification.classificationValue) {
        classifications.delete(key);
        conflictingClassifications.add(key);
        diagnostics.push(diagnostic(item, "framework_classification_conflict", "ambiguous", "classification values conflict"));
      } else {
        const merged = existing ? mergeProvenance(existing.provenance, classification.provenance) : classification.provenance;
        if (merged) {
          classifications.set(key, existing ? { ...existing, provenance: merged } : classification);
          if (!existing) dimension.resolved += 1;
        }
        else {
          classifications.delete(key);
          conflictingClassifications.add(key);
          diagnostics.push(diagnostic(item, "framework_classification_conflict", "ambiguous", "conflicting classification provenance"));
        }
      }
    }
    coverage.set(coverageKey, dimension);
  }
  for (const key of conflictingRelationships) for (const coverageKey of relationshipCoverageKeys.get(key) ?? []) {
    const item = coverage.get(coverageKey);
    if (item && item.ambiguous === 0) coverage.set(coverageKey, { ...item, resolved: Math.max(0, item.resolved - 1), ambiguous: item.ambiguous + 1 });
  }
  for (const key of conflictingClassifications) for (const coverageKey of classificationCoverageKeys.get(key) ?? []) {
    const item = coverage.get(coverageKey);
    if (item && item.ambiguous === 0) coverage.set(coverageKey, { ...item, resolved: Math.max(0, item.resolved - 1), ambiguous: item.ambiguous + 1 });
  }
  for (const keys of entityCollisionCoverageKeys.values()) {
    const orderedKeys = [...keys].sort();
    for (const key of orderedKeys) {
      const item = coverage.get(key);
      if (item) coverage.set(key, { ...item, resolved: 0, ambiguous: 0 });
    }
    const key = orderedKeys[0];
    const item = key ? coverage.get(key) : undefined;
    if (item) coverage.set(key, { ...item, ambiguous: 1 });
  }
  const normalizedDiagnostics = uniqueSorted(diagnostics, (item) => JSON.stringify(item));
  const normalizedCoverage = sorted([...coverage.values()], (item) => `${item.framework}:${item.capability}:${item.relativePath}:${item.strategy}:${item.outputKind}:${item.kind}`);
  return { frameworkResolutionVersion: ctx.frameworkResolutionVersion, entities: sorted([...entities.values()], (item) => frameworkEntityKey(item.ref)), relationships: sorted([...relationships.values()], (item) => JSON.stringify([frameworkSubjectKey(item.source), frameworkSubjectKey(item.target), item.relationKind])), classifications: sorted([...classifications.values()], (item) => JSON.stringify([frameworkSubjectKey(item.subject), item.classificationKind])), diagnostics: normalizedDiagnostics, coverage: normalizedCoverage, config: ctx.config, detections: ctx.detections, dependencies: [], complete: normalizedDiagnostics.length === 0 && !hasIncompleteCoverage(normalizedCoverage) && !hasIncompleteDetectionInputs(ctx.detections, normalizedCoverage) };
}

export function analyzeFramework(ctx: FrameworkAnalysisContext, adapters: readonly FrameworkSemanticAdapter[]): FrameworkMaterialization {
  const evidence: FrameworkEvidence[] = [];
  const diagnostics: FrameworkDiagnostic[] = [];
  const dependencies = new Map<string, FrameworkMaterialization["dependencies"][number]>();
  for (const config of ctx.config.filter((item) => !item.complete)) diagnostics.push({ code: "framework_config_incomplete", outcome: "unknown", framework: "react", capability: "configuration", relativePath: config.relativePath, strategy: config.kind, evidenceIds: [config.inputKey], refs: [{ relativePath: config.relativePath, inputKey: config.inputKey }], reason: "framework configuration is incomplete" });
  const analyzePaths = expandFrameworkAnalyzePaths(ctx.previousFramework, ctx.analyzePaths);
  const facts = ctx.previousFramework
    ? ctx.facts.filter((item) => analyzePaths.has(item.relativePath))
    : ctx.facts;
  const analysisContext = { ...ctx, facts, analyzePaths };
  for (const adapter of sorted(adapters, (item) => item.id)) {
    try {
      const result = adapter.analyze(analysisContext);
      const remaining = Math.max(0, ctx.maxObservations - evidence.length);
      evidence.push(...result.evidence.slice(0, remaining));
      if (result.evidence.length > remaining) evidence.push({ evidenceId: `framework-budget:${adapter.id}`, framework: adapter.frameworks[0] ?? "react", adapterId: adapter.id, adapterVersion: adapter.version, strategy: adapter.id, capability: "adapter", relativePath: "", origin: "framework_inferred", confidence: "exact", refs: [], entities: [], applicable: true, supported: false, attempted: true, state: "budget_exhausted", outputKind: "relationship", relationKind: "component_usage", sourceCandidates: [], targetCandidates: [] });
      for (const dependency of result.dependencies) {
        const key = JSON.stringify([dependency.framework, dependency.scope, dependency.ownerPath]);
        const existing = dependencies.get(key);
        if (!existing) dependencies.set(key, dependency);
        else dependencies.set(key, {
          ...existing,
          inputKeys: [...new Set([...existing.inputKeys, ...dependency.inputKeys])].sort(),
          lookupKeys: [...new Set([...existing.lookupKeys, ...dependency.lookupKeys])].sort(),
          complete: existing.complete && dependency.complete,
        });
      }
    } catch (error) {
      diagnostics.push({ code: "framework_adapter_failed", outcome: "adapter_failed", framework: adapter.frameworks[0] ?? "react", capability: "adapter", relativePath: "", strategy: adapter.id, evidenceIds: [], refs: [], reason: error instanceof Error ? error.message : String(error) });
    }
  }
  const materialized = resolveFrameworkEvidence(analysisContext, evidence);
  if (!ctx.previousFramework) {
    const mergedDiagnostics = uniqueSorted([...materialized.diagnostics, ...diagnostics], (item) => JSON.stringify(item));
    const complete = materialized.complete && mergedDiagnostics.length === 0 && [...dependencies.values()].every((item) => item.complete) && ctx.config.every((item) => item.complete) && !hasIncompleteDetectionInputs(ctx.detections, materialized.coverage) && !hasIncompleteCoverage(materialized.coverage);
    return { ...materialized, dependencies: sorted([...dependencies.values()], (item) => JSON.stringify([item.framework, item.scope, item.ownerPath, item.inputKeys, item.lookupKeys])), diagnostics: mergedDiagnostics, complete };
  }

  const recomputedRelationshipConflicts = new Set<string>();
  const recomputedRelationshipProvenance = new Map<string, FrameworkProvenance>();
  const recomputedClassificationConflicts = new Set<string>();
  const recomputedClassifications = new Map<string, { value: string; provenance: FrameworkProvenance }>();
  for (const item of evidence) {
    if (item.confidence !== "exact" && item.confidence !== "strong") continue;
    if (item.outputKind === "relationship" && item.sourceCandidates.length === 1 && item.targetCandidates.length === 1) {
      const key = JSON.stringify([frameworkSubjectKey(item.sourceCandidates[0]!), frameworkSubjectKey(item.targetCandidates[0]!), item.relationKind]);
      const current = provenance(item);
      const existing = recomputedRelationshipProvenance.get(key);
      if (existing && !mergeProvenance(existing, current)) recomputedRelationshipConflicts.add(key);
      else if (!existing) recomputedRelationshipProvenance.set(key, current);
    } else if (item.outputKind === "classification" && item.subjectCandidates.length === 1 && item.values.length === 1) {
      const key = JSON.stringify([frameworkSubjectKey(item.subjectCandidates[0]!), item.classificationKind]);
      const current = { value: item.values[0]!, provenance: provenance(item) };
      const existing = recomputedClassifications.get(key);
      if (existing && (existing.value !== current.value || !mergeProvenance(existing.provenance, current.provenance))) recomputedClassificationConflicts.add(key);
      else if (!existing) recomputedClassifications.set(key, current);
    }
  }
  const reusedEntities = ctx.previousFramework.entities.filter((item) => !contributesTo(item.provenance, analyzePaths));
  const reusedRelationships = ctx.previousFramework.relationships.filter((item) => !contributesTo(item.provenance, analyzePaths));
  const reusedClassifications = ctx.previousFramework.classifications.filter((item) => !contributesTo(item.provenance, analyzePaths));
  const conflictingRelationships = new Set(recomputedRelationshipConflicts);
  const mergedEntities = new Map(reusedEntities.map((item) => [frameworkEntityKey(item.ref), item]));
  const mergedRelationships = new Map(reusedRelationships.map((item) => [JSON.stringify([frameworkSubjectKey(item.source), frameworkSubjectKey(item.target), item.relationKind]), item]));
  const mergedClassifications = new Map(reusedClassifications.map((item) => [JSON.stringify([frameworkSubjectKey(item.subject), item.classificationKind]), item]));
  const reusedEntityConflicts = new Set<string>();
  const reusedClassificationConflicts = new Set(recomputedClassificationConflicts);
  const coverageConflicts = new Set<string>();
  const coverageConflictGroups = new Map<string, Set<string>>();
  const coverageResolvedRemovals = new Set<string>();
  const previousCoverage = ctx.previousFramework.coverage;
  const markCoverageConflict = (item: { provenance: FrameworkProvenance }, outputKind: "relationship" | "classification", kind: string, outcome: "ambiguous" | "resolved-removal", groupKey?: string): void => {
    for (const coverage of [...previousCoverage, ...materialized.coverage]) {
      if (coverage.framework === item.provenance.framework && coverage.capability === item.provenance.capability && item.provenance.refs.some((ref) => coverage.relativePath === ref.relativePath) && coverage.strategy === item.provenance.strategy && coverage.outputKind === outputKind && coverage.kind === kind) {
        const key = JSON.stringify([coverage.framework, coverage.capability, coverage.relativePath, coverage.strategy, coverage.outputKind, coverage.kind]);
        if (outcome === "ambiguous") {
          coverageConflicts.add(key);
          if (groupKey) {
            if (!coverageConflictGroups.has(groupKey)) coverageConflictGroups.set(groupKey, new Set());
            coverageConflictGroups.get(groupKey)!.add(key);
          }
        }
        else coverageResolvedRemovals.add(key);
      }
    }
  };
  for (const item of evidence) {
    if (item.outputKind === "relationship" && item.sourceCandidates.length === 1 && item.targetCandidates.length === 1) {
      const key = JSON.stringify([frameworkSubjectKey(item.sourceCandidates[0]!), frameworkSubjectKey(item.targetCandidates[0]!), item.relationKind]);
      if (recomputedRelationshipConflicts.has(key)) markCoverageConflict({ provenance: provenance(item) }, "relationship", item.relationKind, "ambiguous", key);
    } else if (item.outputKind === "classification" && item.subjectCandidates.length === 1 && item.values.length === 1) {
      const key = JSON.stringify([frameworkSubjectKey(item.subjectCandidates[0]!), item.classificationKind]);
      if (recomputedClassificationConflicts.has(key)) markCoverageConflict({ provenance: provenance(item) }, "classification", item.classificationKind, "ambiguous", key);
    }
  }
  for (const key of recomputedRelationshipConflicts) {
    const existing = mergedRelationships.get(key);
    if (existing) {
      mergedRelationships.delete(key);
      markCoverageConflict(existing, "relationship", existing.relationKind, "resolved-removal");
    }
  }
  for (const key of recomputedClassificationConflicts) {
    const existing = mergedClassifications.get(key);
    if (existing) {
      mergedClassifications.delete(key);
      markCoverageConflict(existing, "classification", existing.classificationKind, "resolved-removal");
    }
  }
  for (const entity of materialized.entities) {
    const key = frameworkEntityKey(entity.ref);
    const existing = mergedEntities.get(key);
    if (reusedEntityConflicts.has(key)) continue;
    if (!existing) mergedEntities.set(key, entity);
    else if (existing.displayName === entity.displayName) {
      const merged = mergeProvenance(existing.provenance, entity.provenance);
      if (merged) mergedEntities.set(key, { ...existing, provenance: merged });
      else {
        mergedEntities.delete(key);
        reusedEntityConflicts.add(key);
        diagnostics.push({ code: "framework_entity_identity_collision", outcome: "ambiguous", framework: entity.provenance.framework, capability: "entity", relativePath: entity.provenance.refs[0]?.relativePath ?? "", strategy: entity.provenance.strategy, evidenceIds: entity.provenance.evidenceIds, refs: entity.provenance.refs, reason: "conflicting entity provenance" });
      }
    }
    else {
      mergedEntities.delete(key);
      reusedEntityConflicts.add(key);
      diagnostics.push({ code: "framework_entity_identity_collision", outcome: "ambiguous", framework: entity.provenance.framework, capability: "entity", relativePath: entity.provenance.refs[0]?.relativePath ?? "", strategy: entity.provenance.strategy, evidenceIds: entity.provenance.evidenceIds, refs: entity.provenance.refs, reason: "conflicting entity declarations" });
    }
  }
  for (const relationship of materialized.relationships) {
    const key = JSON.stringify([frameworkSubjectKey(relationship.source), frameworkSubjectKey(relationship.target), relationship.relationKind]);
    const existing = mergedRelationships.get(key);
    if (!existing) mergedRelationships.set(key, relationship);
    else {
      if (conflictingRelationships.has(key)) continue;
      const merged = mergeProvenance(existing.provenance, relationship.provenance);
      if (merged) mergedRelationships.set(key, { ...existing, provenance: merged });
      else {
        mergedRelationships.delete(key);
        conflictingRelationships.add(key);
        if (existing) markCoverageConflict(existing, "relationship", relationship.relationKind, "resolved-removal");
        markCoverageConflict(relationship, "relationship", relationship.relationKind, "ambiguous", key);
        diagnostics.push({ code: "framework_target_ambiguous", outcome: "ambiguous", framework: relationship.provenance.framework, capability: "relationship", relativePath: relationship.provenance.refs[0]?.relativePath ?? "", strategy: relationship.provenance.strategy, evidenceIds: relationship.provenance.evidenceIds, refs: relationship.provenance.refs, reason: "conflicting relationship provenance" });
      }
    }
  }
  for (const classification of materialized.classifications) {
    const key = JSON.stringify([frameworkSubjectKey(classification.subject), classification.classificationKind]);
    const existing = mergedClassifications.get(key);
    if (reusedClassificationConflicts.has(key)) continue;
    if (!existing) mergedClassifications.set(key, classification);
    else if (existing.classificationValue === classification.classificationValue) {
      const merged = mergeProvenance(existing.provenance, classification.provenance);
      if (merged) mergedClassifications.set(key, { ...existing, provenance: merged });
      else {
        mergedClassifications.delete(key);
        reusedClassificationConflicts.add(key);
        if (existing) markCoverageConflict(existing, "classification", classification.classificationKind, "resolved-removal");
        markCoverageConflict(classification, "classification", classification.classificationKind, "ambiguous", key);
        diagnostics.push({ code: "framework_classification_conflict", outcome: "ambiguous", framework: classification.provenance.framework, capability: classification.classificationKind, relativePath: classification.provenance.refs[0]?.relativePath ?? "", strategy: classification.provenance.strategy, evidenceIds: classification.provenance.evidenceIds, refs: classification.provenance.refs, reason: "conflicting classification provenance" });
      }
    }
    else {
      mergedClassifications.delete(key);
      reusedClassificationConflicts.add(key);
      if (existing) markCoverageConflict(existing, "classification", classification.classificationKind, "resolved-removal");
      markCoverageConflict(classification, "classification", classification.classificationKind, "ambiguous", key);
      diagnostics.push({ code: "framework_classification_conflict", outcome: "ambiguous", framework: classification.provenance.framework, capability: classification.classificationKind, relativePath: classification.provenance.refs[0]?.relativePath ?? "", strategy: classification.provenance.strategy, evidenceIds: classification.provenance.evidenceIds, refs: classification.provenance.refs, reason: "classification values conflict" });
    }
  }
  const coverageUnknowns = new Set<string>();
  const markCoverageUnknown = (item: { provenance: FrameworkProvenance }, outputKind: "relationship" | "classification", kind: string): void => {
    for (const coverage of [...previousCoverage, ...materialized.coverage]) {
      if (coverage.framework === item.provenance.framework && coverage.capability === item.provenance.capability && coverage.strategy === item.provenance.strategy && coverage.outputKind === outputKind && coverage.kind === kind && item.provenance.refs.some((ref) => ref.relativePath === coverage.relativePath)) {
        coverageUnknowns.add(JSON.stringify([coverage.framework, coverage.capability, coverage.relativePath, coverage.strategy, coverage.outputKind, coverage.kind]));
      }
    }
  };
  const mergedEntityKeys = new Set(mergedEntities.keys());
  for (const [key, relationship] of mergedRelationships) {
    if ((relationship.source.kind === "framework" && !mergedEntityKeys.has(frameworkEntityKey(relationship.source.entity))) || (relationship.target.kind === "framework" && !mergedEntityKeys.has(frameworkEntityKey(relationship.target.entity)))) {
      mergedRelationships.delete(key);
      markCoverageUnknown(relationship, "relationship", relationship.relationKind);
      diagnostics.push({ code: "framework_target_unknown", outcome: "unknown", framework: relationship.provenance.framework, capability: relationship.provenance.capability ?? "relationship", relativePath: relationship.provenance.refs[0]?.relativePath ?? "", strategy: relationship.provenance.strategy, evidenceIds: relationship.provenance.evidenceIds, refs: relationship.provenance.refs, reason: "relationship endpoint is no longer present in the materialized candidate universe" });
    }
  }
  const fullRecompute = ctx.facts.length > 0
    ? ctx.facts.every((item) => analyzePaths.has(item.relativePath))
    : analyzePaths.size === 0;
  const successfulAdapters = new Set(adapters.map((adapter) => adapter.id).filter((id) => !diagnostics.some((item) => item.strategy === id && item.code === "framework_adapter_failed")));
  const reusedDiagnostics = ctx.previousFramework.diagnostics.filter((item) => item.refs.length === 0 ? adapters.some((adapter) => adapter.id === item.strategy) ? !successfulAdapters.has(item.strategy) : false : !item.refs.some((ref) => analyzePaths.has(ref.relativePath)));
  const reusedCoverage = ctx.previousFramework.coverage.filter((item) => !analyzePaths.has(item.relativePath));
  const coverage = new Map<string, FrameworkMaterialization["coverage"][number]>();
  for (const item of [...reusedCoverage, ...materialized.coverage]) {
    const key = JSON.stringify([item.framework, item.capability, item.relativePath, item.strategy, item.outputKind, item.kind]);
    const existing = coverage.get(key);
    const conflict = coverageConflicts.has(key);
    const unknown = coverageUnknowns.has(key);
    const resolvedRemoval = coverageResolvedRemovals.has(key);
    const adjusted = conflict
      ? { ...item, resolved: Math.max(0, item.resolved - 1) }
      : unknown
        ? { ...item, resolved: Math.max(0, item.resolved - 1), unknown: item.unknown + 1 }
        : resolvedRemoval
          ? { ...item, resolved: Math.max(0, item.resolved - 1) }
        : item;
    if (!existing) coverage.set(key, adjusted);
    else coverage.set(key, {
      ...existing,
      applicable: existing.applicable + adjusted.applicable,
      supported: existing.supported + adjusted.supported,
      attempted: existing.attempted + adjusted.attempted,
      resolved: existing.resolved + adjusted.resolved,
      ambiguous: existing.ambiguous + adjusted.ambiguous,
      unknown: existing.unknown + adjusted.unknown,
      unsupported: existing.unsupported + adjusted.unsupported,
      budgetExhausted: existing.budgetExhausted + adjusted.budgetExhausted,
      weakDropped: existing.weakDropped + adjusted.weakDropped,
    });
  }
  for (const keys of coverageConflictGroups.values()) {
    const orderedKeys = [...keys].sort();
    for (const key of orderedKeys) {
      const item = coverage.get(key);
      if (item) coverage.set(key, { ...item, resolved: 0, ambiguous: 0 });
    }
    const key = orderedKeys[0];
    const item = key ? coverage.get(key) : undefined;
    if (item) coverage.set(key, { ...item, ambiguous: 1 });
  }
  const mergedDependencies = new Map<string, FrameworkMaterialization["dependencies"][number]>();
  for (const dependency of [...ctx.previousFramework.dependencies.filter((item) => !analyzePaths.has(item.ownerPath)), ...dependencies.values()]) {
    const key = JSON.stringify([dependency.framework, dependency.scope, dependency.ownerPath]);
    const existing = mergedDependencies.get(key);
    if (!existing) mergedDependencies.set(key, dependency);
    else mergedDependencies.set(key, { ...existing, inputKeys: [...new Set([...existing.inputKeys, ...dependency.inputKeys])].sort(), lookupKeys: [...new Set([...existing.lookupKeys, ...dependency.lookupKeys])].sort(), complete: existing.complete && dependency.complete });
  }
  const mergedDiagnostics = uniqueSorted([...reusedDiagnostics, ...materialized.diagnostics, ...diagnostics], (item) => JSON.stringify(item));
  const incompleteOwners = new Set([
    ...ctx.previousFramework.detections.filter((detection) => !detection.complete).flatMap((detection) => detection.refs.map((ref) => ref.relativePath)),
    ...ctx.previousFramework.config.filter((config) => !config.complete).map((config) => config.relativePath),
    ...ctx.previousFramework.dependencies.filter((dependency) => !dependency.complete).map((dependency) => dependency.ownerPath),
    ...ctx.previousFramework.diagnostics.flatMap((item) => item.refs.map((ref) => ref.relativePath)),
  ]);
  const previousIncompleteCleared = ctx.previousFramework.complete
    || fullRecompute
    || incompleteOwners.size === 0
    || (incompleteOwners.size > 0 && [...incompleteOwners].every((path) => analyzePaths.has(path)));
  const reusedComplete = previousIncompleteCleared
    && ctx.config.every((config) => config.complete)
    && ctx.detections.every((detection) => detection.complete)
    && [...mergedDependencies.values()].every((dependency) => dependency.complete);
  const normalizedCoverage = sorted([...coverage.values()], (item) => `${item.framework}:${item.capability}:${item.relativePath}:${item.strategy}:${item.outputKind}:${item.kind}`);
  return { ...materialized, entities: sorted([...mergedEntities.values()], (item) => frameworkEntityKey(item.ref)), relationships: sorted([...mergedRelationships.values()], (item) => JSON.stringify([frameworkSubjectKey(item.source), frameworkSubjectKey(item.target), item.relationKind])), classifications: sorted([...mergedClassifications.values()], (item) => JSON.stringify([frameworkSubjectKey(item.subject), item.classificationKind])), diagnostics: mergedDiagnostics, coverage: normalizedCoverage, dependencies: sorted([...mergedDependencies.values()], (item) => JSON.stringify([item.framework, item.scope, item.ownerPath, item.inputKeys, item.lookupKeys])), complete: materialized.complete && mergedDiagnostics.length === 0 && reusedDiagnostics.length === 0 && reusedComplete && !hasIncompleteDetectionInputs(ctx.detections, normalizedCoverage) && !hasIncompleteCoverage(normalizedCoverage) };
}

export const builtinFrameworkAdapters: readonly FrameworkSemanticAdapter[] = [flutterAdapter, nestjsAdapter, reactNextAdapter, springAdapter];
