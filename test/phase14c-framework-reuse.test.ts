import assert from "node:assert/strict";
import test from "node:test";

import { analyzeFramework, resolveFrameworkEvidence } from "../src/core/framework/framework-registry.js";
import type { FrameworkAdapterResult, FrameworkAnalysisContext, FrameworkEntityRef, FrameworkEvidence, FrameworkSemanticAdapter, FrameworkSnapshot } from "../src/core/framework/framework.types.js";

const ref = (path: string): FrameworkEntityRef => ({ framework: "next", kind: "route", logicalKey: JSON.stringify(["root", "app", `/${path}`, null, [], null]) });
const provenance = (path: string, id = path) => ({ origin: "framework_inferred" as const, framework: "next" as const, capability: "next.app_routes", adapterId: "test", adapterVersion: "1.0.0", strategy: "test", confidence: "exact" as const, evidenceIds: [id], refs: [{ relativePath: path, inputKey: `facts:${path}` }] });
const entityEvidence = (path: string, route = path): FrameworkEvidence => ({ evidenceId: `entity:${path}:${route}`, framework: "next", adapterId: "test", adapterVersion: "1.0.0", strategy: "test", capability: "next.app_routes", relativePath: path, origin: "framework_inferred", confidence: "exact", refs: [{ relativePath: path, inputKey: `facts:${path}` }], entities: [{ ref: ref(route), displayName: `/${route}`, declarationKey: route, confidence: "exact", refs: [{ relativePath: path, inputKey: `facts:${path}` }] }], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "route_binding", sourceCandidates: [{ kind: "language", nodeId: path }], targetCandidates: [{ kind: "framework", entity: ref(route) }] });

function snapshot(overrides: Partial<FrameworkSnapshot> = {}): FrameworkSnapshot {
  return { repositoryId: "repo", generationId: "old", frameworkResolutionVersion: "1.0.0", entities: [], relationships: [], classifications: [], diagnostics: [], coverage: [], config: [], detections: [], dependencies: [], complete: true, ...overrides };
}

function context(paths: string[], analyzePaths: string[], previousFramework?: FrameworkSnapshot, version = "1.0.0"): FrameworkAnalysisContext {
  return { repositoryId: "repo", generationId: "new", frameworkResolutionVersion: version, detections: [], analyzePaths: new Set(analyzePaths), maxObservations: 100, config: [], graph: { nodes: paths.map((relativePath) => ({ id: relativePath, type: "file" as const, name: relativePath, file: relativePath })), edges: [] }, facts: paths.map((relativePath) => ({ relativePath, facts: {} as never })), previousFramework };
}

function adapter(seen: string[], emit: (path: string) => FrameworkEvidence | undefined): FrameworkSemanticAdapter {
  return { id: "test", version: "1.0.0", frameworks: ["next"], detect: () => [], analyze: (ctx): FrameworkAdapterResult => ({ evidence: ctx.facts.flatMap((unit) => { seen.push(unit.relativePath); const item = emit(unit.relativePath); return item ? [item] : []; }), dependencies: [] }) };
}

test("analyzePaths excludes unrelated facts when reusing a snapshot", () => {
  const seen: string[] = [];
  analyzeFramework(context(["changed.ts", "unchanged.ts"], ["changed.ts"], snapshot()), [adapter(seen, entityEvidence)]);
  assert.deepEqual(seen, ["changed.ts"]);
});

test("unchanged framework outputs survive incremental materialization", () => {
  const old = entityEvidence("unchanged.ts");
  const previous = snapshot({ entities: [{ ref: ref("unchanged.ts"), displayName: "/unchanged.ts", provenance: provenance("unchanged.ts", old.evidenceId) }] });
  const result = analyzeFramework(context(["changed.ts", "unchanged.ts"], ["changed.ts"], previous), [adapter([], () => undefined)]);
  assert.equal(result.entities.length, 1);
  assert.equal(result.entities[0]?.displayName, "/unchanged.ts");
});

test("changed-path output disappears when it is no longer emitted", () => {
  const previous = snapshot({ entities: [{ ref: ref("changed.ts"), displayName: "/changed.ts", provenance: provenance("changed.ts") }] });
  const result = analyzeFramework(context(["changed.ts"], ["changed.ts"], previous), [adapter([], () => undefined)]);
  assert.deepEqual(result.entities, []);
});

test("multi-source output is recomputed with remaining contributors", () => {
  const previous = snapshot({ entities: [{ ref: ref("shared"), displayName: "/shared", provenance: { ...provenance("a.ts", "a"), refs: [{ relativePath: "a.ts", inputKey: "facts:a" }, { relativePath: "b.ts", inputKey: "facts:b" }], evidenceIds: ["a", "b"] } }] });
  const seen: string[] = [];
  const result = analyzeFramework(context(["a.ts", "b.ts"], ["a.ts"], previous), [adapter(seen, (path) => path === "b.ts" ? entityEvidence(path, "shared") : undefined)]);
  assert.deepEqual(seen, ["a.ts", "b.ts"]);
  assert.equal(result.entities.length, 1);
  assert.deepEqual(result.entities[0]?.provenance.refs.map((item) => item.relativePath), ["b.ts"]);
});

test("deleted source removes only its framework contribution", () => {
  const previous = snapshot({ entities: [{ ref: ref("deleted.ts"), displayName: "/deleted.ts", provenance: provenance("deleted.ts") }, { ref: ref("kept.ts"), displayName: "/kept.ts", provenance: provenance("kept.ts") }] });
  const result = analyzeFramework(context(["kept.ts"], ["deleted.ts"], previous), [adapter([], () => undefined)]);
  assert.deepEqual(result.entities.map((item) => item.displayName), ["/kept.ts"]);
});

test("entity rename removes the old logical key and adds the new key", () => {
  const previous = snapshot({ entities: [{ ref: ref("old"), displayName: "/old", provenance: provenance("route.ts") }] });
  const result = analyzeFramework(context(["route.ts"], ["route.ts"], previous), [adapter([], () => entityEvidence("route.ts", "new"))]);
  assert.deepEqual(result.entities.map((item) => item.displayName), ["/new"]);
});

test("recomputed and reused entity conflicts do not retain an arbitrary winner", () => {
  const old = entityEvidence("route.ts", "same");
  const previous = snapshot({ entities: [{ ref: ref("same"), displayName: "/old", provenance: provenance("other.ts") }] });
  const changed = { ...old, entities: [{ ...old.entities[0]!, displayName: "/new" }] };
  const result = analyzeFramework(context(["route.ts", "other.ts"], ["route.ts"], previous), [adapter([], () => changed)]);
  assert.deepEqual(result.entities, []);
  assert.equal(result.diagnostics.some((item) => item.code === "framework_entity_identity_collision"), true);
});

test("cross-generation relationship conflicts are counted as ambiguous", () => {
  const oldEvidence = entityEvidence("old.ts", "same");
  const oldMaterialized = resolveFrameworkEvidence(context(["old.ts"], ["old.ts"]), [oldEvidence]);
  const currentEvidence = { ...oldEvidence, evidenceId: "current", relativePath: "changed.ts", strategy: "different-strategy", refs: [{ relativePath: "changed.ts", inputKey: "facts:changed.ts" }] };
  const result = analyzeFramework(
    context(["changed.ts", "old.ts"], ["changed.ts"], snapshot({ relationships: oldMaterialized.relationships, coverage: oldMaterialized.coverage })),
    [adapter([], () => currentEvidence)],
  );
  const coverage = result.coverage.find((item) => item.outputKind === "relationship");
  assert.equal(coverage?.resolved, 0);
  assert.equal(coverage?.ambiguous, 1);
});

test("incremental relationship conflicts clear reused resolved coverage", () => {
  const oldEvidence = entityEvidence("old.ts", "same");
  const oldMaterialized = resolveFrameworkEvidence(context(["old.ts"], ["old.ts"]), [oldEvidence]);
  const currentEvidence = { ...oldEvidence, evidenceId: "current", relativePath: "changed.ts", strategy: "different-strategy", refs: [{ relativePath: "changed.ts", inputKey: "facts:changed.ts" }], sourceCandidates: [{ kind: "language" as const, nodeId: "old.ts" }] };
  const result = analyzeFramework(context(["changed.ts", "old.ts"], ["changed.ts"], snapshot({ relationships: oldMaterialized.relationships, coverage: oldMaterialized.coverage })), [adapter([], () => currentEvidence)]);
  assert.equal(result.relationships.length, 0);
  assert.equal(result.coverage.reduce((sum, item) => sum + item.resolved, 0), 0);
  assert.equal(result.coverage.reduce((sum, item) => sum + item.ambiguous, 0), 1);
});

test("incremental classification conflicts clear reused resolved coverage", () => {
  const classification = (path: string, value: string, evidenceId: string): FrameworkEvidence => ({ evidenceId, framework: "next", adapterId: "test", adapterVersion: "1.0.0", strategy: "directive", capability: "next.execution_boundary", relativePath: path, origin: "framework_inferred", confidence: "exact", refs: [{ relativePath: path, inputKey: `facts:${path}` }], entities: [], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "classification", classificationKind: "execution_boundary", subjectCandidates: [{ kind: "language", nodeId: "old.ts" }], values: [value] });
  const oldMaterialized = resolveFrameworkEvidence(context(["old.ts"], ["old.ts"]), [classification("old.ts", "client", "old")]);
  const current = classification("changed.ts", "server", "current");
  const result = analyzeFramework(context(["changed.ts", "old.ts"], ["changed.ts"], snapshot({ classifications: oldMaterialized.classifications, coverage: oldMaterialized.coverage })), [adapter([], () => current)]);
  assert.equal(result.classifications.length, 0);
  assert.equal(result.coverage.reduce((sum, item) => sum + item.resolved, 0), 0);
  assert.equal(result.coverage.reduce((sum, item) => sum + item.ambiguous, 0), 1);
});

test("internal recomputed relationship conflicts poison reused output", () => {
  const oldEvidence = { ...entityEvidence("old.ts", "same"), entities: [], targetCandidates: [{ kind: "language" as const, nodeId: "old.ts" }] };
  const oldMaterialized = resolveFrameworkEvidence(context(["old.ts"], ["old.ts"]), [oldEvidence]);
  const first = { ...oldEvidence, evidenceId: "current-a", relativePath: "changed.ts", refs: [{ relativePath: "changed.ts", inputKey: "facts:changed.ts" }], sourceCandidates: [{ kind: "language" as const, nodeId: "old.ts" }] };
  const second = { ...first, evidenceId: "current-b", strategy: "different-strategy" };
  const result = analyzeFramework(context(["changed.ts", "old.ts"], ["changed.ts"], snapshot({ relationships: oldMaterialized.relationships, coverage: oldMaterialized.coverage })), [{ id: "test", version: "1.0.0", frameworks: ["next"], detect: () => [], analyze: () => ({ evidence: [first, second], dependencies: [] }) }]);
  assert.equal(result.relationships.length, 0);
  assert.equal(result.coverage.reduce((sum, item) => sum + item.resolved, 0), 0);
  assert.equal(result.coverage.reduce((sum, item) => sum + item.ambiguous, 0), 1);
});

test("internal recomputed classification conflicts poison reused output", () => {
  const classification = (path: string, value: string, evidenceId: string, strategy = "directive"): FrameworkEvidence => ({ evidenceId, framework: "next", adapterId: "test", adapterVersion: "1.0.0", strategy, capability: "next.execution_boundary", relativePath: path, origin: "framework_inferred", confidence: "exact", refs: [{ relativePath: path, inputKey: `facts:${path}` }], entities: [], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "classification", classificationKind: "execution_boundary", subjectCandidates: [{ kind: "language", nodeId: "old.ts" }], values: [value] });
  const oldMaterialized = resolveFrameworkEvidence(context(["old.ts"], ["old.ts"]), [classification("old.ts", "client", "old")]);
  const first = classification("changed.ts", "client", "current-a");
  const second = classification("changed.ts", "server", "current-b", "different-strategy");
  const result = analyzeFramework(context(["changed.ts", "old.ts"], ["changed.ts"], snapshot({ classifications: oldMaterialized.classifications, coverage: oldMaterialized.coverage })), [{ id: "test", version: "1.0.0", frameworks: ["next"], detect: () => [], analyze: () => ({ evidence: [first, second], dependencies: [] }) }]);
  assert.equal(result.classifications.length, 0);
  assert.equal(result.coverage.reduce((sum, item) => sum + item.resolved, 0), 0);
  assert.equal(result.coverage.reduce((sum, item) => sum + item.ambiguous, 0), 1);
});

test("resolver rejects missing and ambiguous relationship endpoints", () => {
  const missing = { ...entityEvidence("source.ts", "missing"), entities: [] };
  const missingResult = resolveFrameworkEvidence(context(["source.ts"], ["source.ts"]), [missing]);
  assert.equal(missingResult.relationships.length, 0);
  assert.equal(missingResult.diagnostics.some((item) => item.outcome === "unknown"), true);

  const ambiguous = { ...missing, targetCandidates: [{ kind: "language" as const, nodeId: "target-a" }, { kind: "language" as const, nodeId: "target-b" }] };
  const ambiguousContext = { ...context(["source.ts"], ["source.ts"]), graph: { nodes: [{ id: "source.ts", type: "file" as const, name: "source.ts", file: "source.ts" }, { id: "target-a", type: "class" as const, name: "Target", file: "a.ts" }, { id: "target-b", type: "class" as const, name: "Target", file: "b.ts" }], edges: [] } };
  const ambiguousResult = resolveFrameworkEvidence(ambiguousContext, [ambiguous]);
  assert.equal(ambiguousResult.relationships.length, 0);
  assert.equal(ambiguousResult.diagnostics.some((item) => item.outcome === "ambiguous"), true);
});

test("resolver rejects a relationship whose framework endpoint is conflicted", () => {
  const first = entityEvidence("source.ts", "conflict");
  const second = { ...first, evidenceId: "entity:source.ts:conflict:second", entities: [{ ...first.entities[0]!, displayName: "/different" }] };
  const result = resolveFrameworkEvidence(context(["source.ts"], ["source.ts"]), [first, second]);
  assert.equal(result.entities.length, 0);
  assert.equal(result.relationships.length, 0);
  assert.equal(result.diagnostics.some((item) => item.code === "framework_entity_identity_collision"), true);
});

test("classification conflicts remove the resolved coverage count", () => {
  const base = entityEvidence("source.ts", "same");
  const first = { ...base, outputKind: "classification" as const, classificationKind: "execution_boundary" as const, subjectCandidates: [{ kind: "language" as const, nodeId: "source.ts" }], values: ["client"], relationKind: undefined } as never;
  const second = { ...first, evidenceId: "classification:second", values: ["server"] } as never;
  const result = resolveFrameworkEvidence(context(["source.ts"], ["source.ts"]), [first, second]);
  const coverage = result.coverage.find((item) => item.outputKind === "classification");
  assert.equal(result.classifications.length, 0);
  assert.equal(coverage?.resolved, 0);
  assert.equal(coverage?.ambiguous, 1);
});

test("an incomplete prior snapshot recovers only after its owning path is recomputed", () => {
  const previous = snapshot({ complete: false, config: [{ relativePath: "package.json", scope: "root", inputKey: "package:root", kind: "package", values: {}, complete: false }], dependencies: [{ framework: "next", scope: "root", ownerPath: "owned.ts", inputKeys: [], lookupKeys: [], complete: false }] });
  const recoveredContext = { ...context(["owned.ts"], ["owned.ts"], previous), config: [{ relativePath: "package.json", scope: "root", inputKey: "package:root", kind: "package" as const, values: {}, complete: true }] };
  const recovered = analyzeFramework(recoveredContext, [adapter([], () => undefined)]);
  assert.equal(recovered.complete, true);

  const unrelated = analyzeFramework(context(["owned.ts", "other.ts"], ["other.ts"], previous), [adapter([], () => undefined)]);
  assert.equal(unrelated.complete, false);
});

test("dependency-expanded analyze paths are passed to adapters", () => {
  const seen: string[] = [];
  analyzeFramework(context(["owner.ts", "dependent.ts"], ["owner.ts", "dependent.ts"], snapshot()), [adapter(seen, entityEvidence)]);
  assert.deepEqual([...seen].sort(), ["dependent.ts", "owner.ts"]);
});

test("framework version bump analyzes every current framework path", () => {
  const seen: string[] = [];
  analyzeFramework(context(["a.ts", "b.ts"], ["a.ts", "b.ts"], snapshot(), "2.0.0"), [adapter(seen, () => undefined)]);
  assert.deepEqual(seen, ["a.ts", "b.ts"]);
});

test("incremental reuse matches clean materialization", () => {
  const paths = ["a.ts", "b.ts"];
  const clean = analyzeFramework(context(paths, paths), [adapter([], entityEvidence)]);
  const incremental = analyzeFramework(context(paths, ["a.ts"], snapshot({ ...clean, generationId: "old" })), [adapter([], entityEvidence)]);
  assert.deepEqual({ entities: incremental.entities, relationships: incremental.relationships, classifications: incremental.classifications, diagnostics: incremental.diagnostics, coverage: incremental.coverage, dependencies: incremental.dependencies, complete: incremental.complete }, { entities: clean.entities, relationships: clean.relationships, classifications: clean.classifications, diagnostics: clean.diagnostics, coverage: clean.coverage, dependencies: clean.dependencies, complete: clean.complete });
});

test("reused and recomputed coverage dimensions do not double-count", () => {
  const previous = snapshot({ coverage: [{ framework: "next", capability: "next.app_routes", relativePath: "b.ts", strategy: "test", outputKind: "relationship", kind: "route_binding", applicable: 1, supported: 1, attempted: 1, resolved: 1, ambiguous: 0, unknown: 0, unsupported: 0, budgetExhausted: 0, weakDropped: 0 }] });
  const result = analyzeFramework(context(["a.ts", "b.ts"], ["a.ts"], previous), [adapter([], entityEvidence)]);
  assert.equal(result.coverage.reduce((sum, item) => sum + item.attempted, 0), 2);
});

test("duplicate semantic observations merge provenance deterministically", () => {
  const first = entityEvidence("shared.ts", "shared");
  const second = { ...first, evidenceId: "entity:shared.ts:shared:second" };
  const result = resolveFrameworkEvidence(context(["shared.ts"], ["shared.ts"]), [first, second]);
  assert.equal(result.entities[0]?.provenance.evidenceIds.length, 2);
  assert.equal(result.relationships[0]?.provenance.evidenceIds.length, 2);
  assert.equal(result.coverage.find((item) => item.outputKind === "relationship")?.resolved, 1);
});

test("distinct observations count attempts without double-counting the accepted output", () => {
  const first = entityEvidence("shared.ts", "shared");
  const second = { ...first, evidenceId: "entity:shared.ts:shared:second" };
  const result = resolveFrameworkEvidence(context(["shared.ts"], ["shared.ts"]), [first, second]);
  const coverage = result.coverage.find((item) => item.outputKind === "relationship" && item.strategy === "test");
  assert.equal(result.relationships.length, 1);
  assert.equal(coverage?.attempted, 2);
  assert.equal(result.coverage.reduce((sum, item) => sum + item.resolved, 0), 1);
});

test("cold diagnostic materialization is incomplete", () => {
  const evidence = { ...entityEvidence("source.ts", "missing"), entities: [] };
  const result = resolveFrameworkEvidence(context(["source.ts"], ["source.ts"]), [evidence]);
  assert.equal(result.diagnostics.some((item) => item.code === "framework_target_unknown"), true);
  assert.equal(result.complete, false);
});

test("unsupported evidence never becomes an accepted relationship", () => {
  const evidence = { ...entityEvidence("source.ts", "unsupported"), supported: false, state: "unsupported" as const };
  const result = resolveFrameworkEvidence(context(["source.ts"], ["source.ts"]), [evidence]);
  assert.equal(result.relationships.length, 0);
  assert.equal(result.diagnostics.some((item) => item.code === "framework_construct_unsupported"), true);
  assert.equal(result.coverage.find((item) => item.outputKind === "relationship")?.unsupported, 1);
  assert.equal(result.complete, false);
});

test("recomputing a diagnostic owner clears stale uncertainty", () => {
  const previous = snapshot({ complete: false, diagnostics: [{ code: "framework_target_unknown", outcome: "unknown", framework: "next", capability: "next.routes", relativePath: "route.ts", strategy: "route", evidenceIds: ["old"], refs: [{ relativePath: "route.ts", inputKey: "facts:route.ts" }], reason: "target was missing" }] });
  const result = analyzeFramework(context(["route.ts"], ["route.ts"], previous), [adapter([], () => undefined)]);
  assert.deepEqual(result.diagnostics, []);
  assert.equal(result.complete, true);
});

test("unattempted evidence never becomes an accepted relationship", () => {
  const evidence = { ...entityEvidence("source.ts", "unattempted"), attempted: false };
  const result = resolveFrameworkEvidence(context(["source.ts"], ["source.ts"]), [evidence]);
  assert.equal(result.relationships.length, 0);
  assert.equal(result.coverage.find((item) => item.outputKind === "relationship")?.unknown, 1);
  assert.equal(result.complete, false);
});

test("non-applicable evidence never becomes an accepted relationship", () => {
  const evidence = { ...entityEvidence("source.ts", "not-applicable"), applicable: false };
  const result = resolveFrameworkEvidence(context(["source.ts"], ["source.ts"]), [evidence]);
  assert.equal(result.relationships.length, 0);
  assert.equal(result.coverage.find((item) => item.outputKind === "relationship")?.applicable, 0);
  assert.equal(result.coverage.find((item) => item.outputKind === "relationship")?.supported, 0);
  assert.equal(result.coverage.find((item) => item.outputKind === "relationship")?.attempted, 0);
});

test("incomplete cold dependencies keep materialization incomplete", () => {
  const result = analyzeFramework(context(["source.ts"], ["source.ts"]), [{ id: "dependency", version: "1.0.0", frameworks: ["next"], detect: () => [], analyze: () => ({ evidence: [], dependencies: [{ framework: "next", scope: "root", ownerPath: "package.json", inputKeys: ["package"], lookupKeys: ["next"], complete: false }] }) }]);
  assert.equal(result.complete, false);
});

test("configured-only and observed-without-coverage detections keep cold materialization incomplete", () => {
  const configured = analyzeFramework({ ...context(["source.ts"], ["source.ts"]), detections: [{ framework: "next", scope: "root", configured: true, observed: false, capabilities: [], refs: [], complete: true }] }, [adapter([], () => undefined)]);
  assert.equal(configured.complete, false);
  const observed = analyzeFramework({ ...context(["source.ts"], ["source.ts"]), detections: [{ framework: "next", scope: "root", configured: false, observed: true, capabilities: ["next.routes"], refs: [], complete: true }] }, [adapter([], () => undefined)]);
  assert.equal(observed.complete, false);
});

test("observed capability without matching coverage remains incomplete", () => {
  const evidence = { ...entityEvidence("source.ts"), capability: "next.pages_routes" };
  const result = analyzeFramework({ ...context(["source.ts"], ["source.ts"]), detections: [{ framework: "next", scope: "root", configured: false, observed: true, capabilities: ["next.app_routes"], refs: [], complete: true }] }, [adapter([], () => evidence)]);
  assert.equal(result.complete, false);
});

test("empty-reference diagnostics clear after their adapter reruns", () => {
  const previous = snapshot({ complete: false, diagnostics: [{ code: "framework_adapter_failed", outcome: "adapter_failed", framework: "next", capability: "adapter", relativePath: "", strategy: "test", evidenceIds: [], refs: [], reason: "adapter failed" }] });
  const result = analyzeFramework(context(["changed.ts", "unrelated.ts"], ["unrelated.ts"], previous), [adapter([], () => undefined)]);
  assert.equal(result.diagnostics.some((item) => item.code === "framework_adapter_failed"), false);
  assert.equal(result.complete, true);
});

test("ambiguous classification subjects use the subject diagnostic", () => {
  const base = entityEvidence("source.ts", "subject");
  const first = { ...base, outputKind: "classification" as const, classificationKind: "execution_boundary" as const, subjectCandidates: [{ kind: "language" as const, nodeId: "source.ts" }, { kind: "language" as const, nodeId: "other.ts" }], values: ["client" as const], relationKind: undefined } as never;
  const result = resolveFrameworkEvidence(context(["source.ts", "other.ts"], ["source.ts"]), [first]);
  assert.equal(result.diagnostics.some((item) => item.code === "framework_subject_ambiguous"), true);
});

test("entity collisions contribute ambiguous coverage", () => {
  const first = entityEvidence("source.ts", "collision");
  const second = { ...first, evidenceId: "collision:second", entities: [{ ...first.entities[0]!, displayName: "/different" }] };
  const result = resolveFrameworkEvidence(context(["source.ts"], ["source.ts"]), [first, second]);
  const coverage = result.coverage.find((item) => item.outputKind === "relationship");
  assert.equal(coverage?.ambiguous, 1);
  assert.equal(coverage?.unknown, 0);
});
