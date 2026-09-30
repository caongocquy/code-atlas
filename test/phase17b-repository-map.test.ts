import assert from "node:assert/strict";
import test from "node:test";

import { parseArchitecturePolicy, defaultArchitecturePolicy } from "../src/core/architecture/architecture-policy.js";
import type { FrameworkEntity, FrameworkProvenance, FrameworkRelationship } from "../src/core/framework/framework.types.js";
import type { FrameworkQueryProjection } from "../src/core/graph/query/framework-query.types.js";
import type { CodeGraph, GraphEdge, GraphNode } from "../src/core/graph/types.js";
import { detectCommunities } from "../src/core/graph/intelligence/communities.service.js";
import { buildRepositoryMap } from "../src/core/graph/intelligence/repository-map.service.js";

const node = (id: string, file: string, type: GraphNode["type"] = "function"): GraphNode => ({ id, name: id, qualifiedName: id, type, file });
const edge = (from: string, to: string, type: GraphEdge["type"], resolutionMethod?: GraphEdge["resolutionMethod"]): GraphEdge => ({
  from, to, type, evidenceKind: resolutionMethod ? "INFERRED" : "EXTRACTED", ...(resolutionMethod ? { resolutionMethod } : {}),
  ...(resolutionMethod === "scip" ? { resolution: { strategy: "scip", confidence: "exact", evidence: [{ kind: "INFERRED", sourceUnit: "src/api/controller.ts", startLine: 3, endLine: 3 }], resolutionVersion: "2.0.0", sourceLogicalIdentity: from, targetLogicalIdentity: to } } : {}),
});
const policy = (groups: { id: string; include: string[] }[]) => parseArchitecturePolicy({ version: 1, architecture: { groups } });

function frameworkFixture(graph: CodeGraph, relationships: FrameworkRelationship[], mayBeIncomplete = false): FrameworkQueryProjection {
  const entities: FrameworkEntity[] = relationships.flatMap((item) => item.target.kind === "framework"
    ? [{ ref: item.target.entity, displayName: item.target.entity.logicalKey, provenance: item.provenance }]
    : []);
  return {
    nodes: [...graph.nodes.map((item) => ({ kind: "language" as const, node: item })), ...entities.map((entity) => ({ kind: "framework" as const, entity }))],
    edges: [...graph.edges.map((item) => ({ kind: "language" as const, edge: item })), ...relationships.map((relationship) => ({ kind: "framework" as const, relationship }))],
    classifications: [], diagnostics: [], coverage: [], mayBeIncomplete,
    reliability: mayBeIncomplete ? {
      scope: { scopeKey: "test", capability: "framework_repository" }, outcome: "unknown", complete: false, stale: true,
      authoritative: false, authoritativeNegative: false,
      coverage: { applicable: 1, supported: 1, attempted: 1, resolved: 0, ambiguous: 0, unknown: 1, unsupported: 0, budgetExhausted: 0 },
      diagnosticCodes: [], evidenceSummary: { total: 0, origins: [] },
    } : undefined,
  };
}

function route(framework: "nestjs" | "spring" | "next", nodeId: string, kind: "controller_route" | "route_binding"): FrameworkRelationship {
  const ref = { framework, kind: "route" as const, logicalKey: JSON.stringify(["root", "http", `/${nodeId}`, "GET", [], null]) };
  const provenance: FrameworkProvenance = {
    origin: "framework_inferred", framework, capability: `${framework}.routes`, adapterId: framework,
    adapterVersion: "1.0.0", strategy: "fresh-fixture", confidence: "exact", evidenceIds: [`route:${nodeId}`], refs: [],
  };
  return { outputKind: "relationship", source: { kind: "language", nodeId }, target: { kind: "framework", entity: ref }, relationKind: kind, provenance };
}

const groupsGraph: CodeGraph = {
  nodes: [node("api", "src/api/controller.ts", "class"), node("handler", "src/api/controller.ts", "method"), node("service", "src/service/service.ts", "class"), node("util", "src/other/util.ts")],
  edges: [edge("handler", "service", "calls", "scip"), edge("handler", "service", "imports"), edge("handler", "service", "extends"), edge("handler", "service", "implements"), edge("handler", "service", "contains"), edge("service", "util", "references")],
};

test("no groups and cycle-only policy use existing structural community IDs and member sets", () => {
  const baseline = detectCommunities(groupsGraph, { maxResults: 10_000, includeSingletons: true });
  for (const architecturePolicy of [defaultArchitecturePolicy(), parseArchitecturePolicy({ version: 1, architecture: { cycles: { enabled: true } } })]) {
    const map = buildRepositoryMap(groupsGraph, architecturePolicy);
    assert.equal(map.boundarySource, "structural_community");
    assert.deepEqual(map.areas.map((area) => [area.id, area.symbolCount, area.memberIds]).sort(), baseline.communities.map((item) => [item.id, item.size, item.memberIds]).sort());
    assert.equal(map.identityStability, "graph_generation_member_set");
  }
});

test("configured groups are primary, include empty declared areas, and report ambiguous/unclassified files without guessing", () => {
  const graph: CodeGraph = {
    nodes: [node("a", "src/api/a.ts"), node("b", "src/shared/b.ts"), node("c", "src/orphan/c.ts")], edges: [],
  };
  const map = buildRepositoryMap(graph, policy([
    { id: "api", include: ["src/api/**", "src/shared/**"] },
    { id: "shared", include: ["src/shared/**"] },
    { id: "empty", include: ["src/empty/**"] },
  ]));
  assert.equal(map.boundarySource, "architecture_group");
  assert.equal(map.identityStability, "configuration_stable");
  assert.deepEqual(map.areas.map((area) => area.id), ["api", "empty", "shared"]);
  assert.equal(map.areas[0]?.symbolCount, 1);
  assert.deepEqual(map.diagnostics.ambiguousFiles, { count: 1, paths: ["src/shared/b.ts"] });
  assert.deepEqual(map.diagnostics.unclassifiedFiles, { count: 1, paths: ["src/orphan/c.ts"] });
  assert.equal(map.mayBeIncomplete, true);
});

test("area and relation ordering stays deterministic when graph inputs are reordered", () => {
  const configured = policy([{ id: "api", include: ["src/api/**"] }, { id: "service", include: ["src/service/**"] }, { id: "other", include: ["src/other/**"] }]);
  const first = buildRepositoryMap(groupsGraph, configured);
  const second = buildRepositoryMap({ nodes: [...groupsGraph.nodes].reverse(), edges: [...groupsGraph.edges].reverse() }, configured);
  assert.deepEqual(first, second);
});

test("coupling remains directed, counts architectural edge types, and preserves resolution provenance", () => {
  const configured = policy([{ id: "api", include: ["src/api/**"] }, { id: "service", include: ["src/service/**"] }, { id: "other", include: ["src/other/**"] }]);
  const map = buildRepositoryMap(groupsGraph, configured);
  assert.deepEqual(map.relations.map((item) => [item.sourceAreaId, item.targetAreaId, item.edgeCount, item.relationCounts]), [
    ["api", "service", 4, { calls: 1, imports: 1, extends: 1, implements: 1 }], ["service", "other", 1, { references: 1 }],
  ]);
  assert.deepEqual(map.areas.find((item) => item.id === "api")?.memberIds, ["api", "handler"]);
  const call = map.relations[0]?.representativeEdges.find((item) => item.type === "calls");
  assert.equal(call?.resolutionMethod, "scip");
  assert.equal(call?.resolution?.strategy, "scip");
  assert.equal(map.areas.find((item) => item.id === "api")?.internalEdgeCount, 0);
  assert.equal(map.areas.find((item) => item.id === "api")?.externalEdgeCount, 4);
});

test("area representatives are deterministic and come from existing community/importance evidence", () => {
  const configured = policy([{ id: "api", include: ["src/api/**"] }, { id: "service", include: ["src/service/**"] }, { id: "other", include: ["src/other/**"] }]);
  const first = buildRepositoryMap(groupsGraph, configured);
  const second = buildRepositoryMap({ nodes: [...groupsGraph.nodes].reverse(), edges: [...groupsGraph.edges].reverse() }, configured);
  assert.deepEqual(first.areas.map((area) => [area.id, area.representativeSymbols.map((symbol) => symbol.id)]), second.areas.map((area) => [area.id, area.representativeSymbols.map((symbol) => symbol.id)]));
  assert.equal(first.areas.every((area) => area.representativeSymbols.every((symbol) => symbol.type !== "file")), true);
});

test("NestJS, Spring, and Next file-route entry facets follow touched language nodes", () => {
  const graph: CodeGraph = { nodes: [node("controller", "src/nest/controller.ts", "class"), node("bean", "src/spring/bean.java", "class"), node("next-file", "src/next/app/api/route.ts", "file")], edges: [] };
  const relationships = [route("nestjs", "controller", "controller_route"), route("spring", "bean", "controller_route"), route("next", "next-file", "route_binding")];
  const framework = frameworkFixture(graph, relationships);
  const configured = policy([{ id: "nest", include: ["src/nest/**"] }, { id: "spring", include: ["src/spring/**"] }, { id: "next", include: ["src/next/**"] }]);
  const map = buildRepositoryMap(graph, configured, framework);
  assert.deepEqual(map.areas.map((area) => [area.id, area.frameworkIds, area.executionEntryBindingCount]), [
    ["nest", ["nestjs"], 1], ["spring", ["spring"], 1], ["next", ["next"], 1],
  ]);
  assert.equal(map.areas.find((area) => area.id === "next")?.representativeSymbols.length, 0);
});

test("framework reliability and incomplete evidence propagate to map coverage", () => {
  const graph: CodeGraph = { nodes: [node("controller", "src/nest/controller.ts", "class")], edges: [] };
  const framework = frameworkFixture(graph, [route("nestjs", "controller", "controller_route")], true);
  const map = buildRepositoryMap(graph, policy([{ id: "nest", include: ["src/nest/**"] }]), framework, { graphMayBeIncomplete: true });
  assert.equal(map.mayBeIncomplete, true);
  assert.equal(map.coverage.graphMayBeIncomplete, true);
  assert.equal(map.coverage.frameworkMayBeIncomplete, true);
  assert.equal(map.frameworkReliability?.authoritativeNegative, false);
  assert.equal(map.diagnostics.frameworkDiagnostics.length, 0);
});

test("unmapped architectural edges are diagnosed and contains never becomes coupling", () => {
  const graph: CodeGraph = { nodes: [node("api", "src/api/a.ts"), node("ambiguous", "src/shared/b.ts"), node("orphan", "src/outside/o.ts")], edges: [edge("api", "orphan", "calls"), edge("api", "ambiguous", "references"), edge("api", "orphan", "contains")] };
  const map = buildRepositoryMap(graph, policy([
    { id: "api", include: ["src/api/**", "src/shared/**"] },
    { id: "shared", include: ["src/shared/**"] },
  ]));
  assert.equal(map.relations.length, 0);
  assert.equal(map.diagnostics.unmappedArchitecturalEdges.count, 2);
  assert.equal(map.diagnostics.unmappedArchitecturalEdges.ambiguousEndpointCount, 1);
  assert.equal(map.diagnostics.unmappedArchitecturalEdges.unclassifiedEndpointCount, 1);
});
