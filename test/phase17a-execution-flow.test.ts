import assert from "node:assert/strict";
import test from "node:test";

import { discoverExecutionFlow } from "../src/core/graph/query/execution-flow.service.js";
import type { CodeGraph, GraphEdge, GraphNode } from "../src/core/graph/types.js";
import type { FrameworkEntity, FrameworkProvenance, FrameworkRelationship } from "../src/core/framework/framework.types.js";
import type { FrameworkQueryProjection } from "../src/core/graph/query/framework-query.types.js";

const symbol = (id: string, name = id, type: GraphNode["type"] = "method"): GraphNode => ({
  id,
  type,
  name,
  qualifiedName: name,
  file: `src/${id}.ts`,
  startLine: 1,
  endLine: 4,
});

const call = (from: string, to: string, evidenceKind: GraphEdge["evidenceKind"] = "EXTRACTED", strategy = "fixture"): GraphEdge => ({
  from,
  to,
  type: "calls",
  resolutionMethod: "same_file",
  evidenceKind,
  confidence: 1,
  resolutionSource: { file: `src/${from}.ts`, line: 2 },
  resolution: { strategy, confidence: "exact", evidence: [{ kind: evidenceKind ?? "EXTRACTED", sourceUnit: `src/${from}.ts`, startLine: 2, endLine: 2 }], resolutionVersion: "2.0.0", sourceLogicalIdentity: from, targetLogicalIdentity: to },
});

function routeFixture(framework: "nestjs" | "spring" | "next", path: string, method: string | null, handler: GraphNode): {
  entity: FrameworkEntity;
  relationship: FrameworkRelationship;
} {
  const logicalKey = JSON.stringify(["root", framework === "spring" ? "mvc" : "http", path, method, [], handler.qualifiedName]);
  const ref = { framework, kind: "route" as const, logicalKey };
  const provenance: FrameworkProvenance = {
    origin: "framework_inferred",
    framework,
    capability: `${framework}.routes`,
    adapterId: framework,
    adapterVersion: "1.0.0",
    strategy: "route-fixture",
    confidence: "exact",
    evidenceIds: [`route:${path}`],
    refs: [{ relativePath: handler.file, inputKey: `facts:${handler.file}`, localId: "route", range: { startLine: 1, endLine: 1 } }],
  };
  const entity: FrameworkEntity = { ref, displayName: logicalKey, provenance };
  const relationship: FrameworkRelationship = {
    outputKind: "relationship",
    source: { kind: "language", nodeId: handler.id },
    target: { kind: "framework", entity: ref },
    relationKind: framework === "next" ? "route_binding" : "controller_route",
    provenance,
  };
  return { entity, relationship };
}

function projection(graph: CodeGraph, relationships: FrameworkRelationship[] = [], entities: FrameworkEntity[] = [], mayBeIncomplete = false): FrameworkQueryProjection {
  return {
    nodes: [
      ...graph.nodes.map((node) => ({ kind: "language" as const, node })),
      ...entities.map((entity) => ({ kind: "framework" as const, entity })),
    ],
    edges: [
      ...graph.edges.map((edge) => ({ kind: "language" as const, edge })),
      ...relationships.map((relationship) => ({ kind: "framework" as const, relationship })),
    ],
    classifications: [], diagnostics: [], coverage: [], mayBeIncomplete,
  };
}

test("language flow preserves deterministic branches and call-edge provenance", () => {
  const graph: CodeGraph = {
    nodes: [symbol("handler"), symbol("z-service"), symbol("a-service"), symbol("repo"), symbol("imported-only")],
    edges: [
      call("handler", "z-service"), call("handler", "a-service"), call("a-service", "repo", "INFERRED", "scip"),
      { from: "handler", to: "imported-only", type: "imports" },
      { from: "handler", to: "imported-only", type: "references" },
    ],
  };
  const result = discoverExecutionFlow(graph, undefined, { kind: "symbol", query: "handler" });

  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;
  assert.deepEqual(result.nodes.map((item) => item.subject.kind === "language" ? item.subject.node.id : "route"), ["handler", "a-service", "z-service", "repo"]);
  assert.deepEqual(result.edges.map((item) => [item.kind, item.from, item.to]), [
    ["call", '["language","handler"]', '["language","a-service"]'],
    ["call", '["language","handler"]', '["language","z-service"]'],
    ["call", '["language","a-service"]', '["language","repo"]'],
  ]);
  assert.equal(result.edges[0]?.kind === "call" && result.edges[0].evidence[0]?.resolutionSource?.file, "src/handler.ts");
  const scipEdge = result.edges.find((edge) => edge.kind === "call" && edge.from === '["language","a-service"]');
  assert.equal(scipEdge?.kind === "call" ? scipEdge.evidence[0]?.resolution?.strategy : undefined, "scip");
  assert.deepEqual(result.terminals.map((item) => item.nodeId), ['["language","z-service"]', '["language","repo"]']);
});

test("language flow reports cycles and terminates repeated calls", () => {
  const graph: CodeGraph = {
    nodes: [symbol("a"), symbol("b"), symbol("c")],
    edges: [call("a", "b"), call("b", "c"), call("c", "a")],
  };
  const result = discoverExecutionFlow(graph, undefined, { kind: "symbol", query: "a" });

  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;
  assert.equal(result.nodes.length, 3);
  assert.deepEqual(result.cycles.map((cycle) => [cycle.from, cycle.to]), [['["language","c"]', '["language","a"]']]);
  assert.equal(result.truncated, false);
});

test("language flow reports maxDepth and maxNodes truncation", () => {
  const graph: CodeGraph = {
    nodes: [symbol("root"), symbol("left"), symbol("right"), symbol("leaf")],
    edges: [call("root", "left"), call("root", "right"), call("left", "leaf")],
  };
  const depthLimited = discoverExecutionFlow(graph, undefined, { kind: "symbol", query: "root" }, { maxDepth: 1 });
  const nodeLimited = discoverExecutionFlow(graph, undefined, { kind: "symbol", query: "root" }, { maxNodes: 2 });

  assert.equal(depthLimited.status, "resolved");
  if (depthLimited.status === "resolved") assert.deepEqual(depthLimited.truncatedBy, ["maxDepth"]);
  assert.equal(nodeLimited.status, "resolved");
  if (nodeLimited.status === "resolved") {
    assert.equal(nodeLimited.nodes.length, 2);
    assert.deepEqual(nodeLimited.truncatedBy, ["maxNodes"]);
  }
});

test("language entry resolution distinguishes ambiguity, absence, and stale coverage", () => {
  const graph: CodeGraph = {
    nodes: [symbol("one", "same"), symbol("two", "same")],
    edges: [],
  };
  assert.equal(discoverExecutionFlow(graph, undefined, { kind: "symbol", query: "same" }).status, "ambiguous");
  assert.equal(discoverExecutionFlow(graph, undefined, { kind: "symbol", query: "missing" }).status, "not_found");
  const stale = discoverExecutionFlow(graph, undefined, { kind: "symbol", query: "src/one.ts:same" }, { coverage: { mayBeIncomplete: true } });
  assert.equal(stale.status, "resolved");
  if (stale.status === "resolved") assert.equal(stale.mayBeIncomplete, true);
});

for (const framework of ["nestjs", "spring"] as const) {
  test(`${framework} route enters controller method and follows calls`, () => {
    const handler = symbol("controller", "UsersController.list");
    const service = symbol("service", "UsersService.list");
    const repository = symbol("repository", "UsersRepository.find");
    const graph: CodeGraph = { nodes: [handler, service, repository], edges: [call("controller", "service"), call("service", "repository")] };
    const route = routeFixture(framework, "/users", "GET", handler);
    const injection: FrameworkRelationship = {
      ...route.relationship,
      target: { kind: "language", nodeId: repository.id },
      relationKind: "dependency_injection",
    };
    const frameworkProjection = {
      ...projection(graph, [route.relationship, injection], [route.entity]),
      reliability: { complete: true, stale: false } as never,
    };
    const result = discoverExecutionFlow(graph, frameworkProjection, {
      kind: "route", framework, path: "/users", method: "GET",
    });

    assert.equal(result.status, "resolved");
    if (result.status !== "resolved") return;
    assert.deepEqual(result.edges.map((item) => item.kind), ["framework_entry", "call", "call"]);
    assert.deepEqual(result.nodes.filter((item) => item.subject.kind === "language").map((item) => item.subject.node.name), [
      "UsersController.list", "UsersService.list", "UsersRepository.find",
    ]);
    assert.equal(result.edges[0]?.kind === "framework_entry" && result.edges[0].provenance.adapterId, framework);
    assert.deepEqual(result.frameworkReliability, { complete: true, stale: false });
  });
}

test("Next file-bound route returns an incomplete file boundary without inventing a handler", () => {
  const file = symbol("file", "app/api/users/route.ts", "file");
  const route = routeFixture("next", "/api/users", null, file);
  const graph: CodeGraph = { nodes: [file], edges: [] };
  const result = discoverExecutionFlow(graph, projection(graph, [route.relationship], [route.entity]), {
    kind: "route", framework: "next", path: "/api/users", method: null,
  });

  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;
  assert.deepEqual(result.edges.map((item) => item.kind), ["framework_entry"]);
  assert.equal(result.nodes.filter((item) => item.subject.kind === "language" && item.subject.node.type !== "file").length, 0);
  assert.equal(result.mayBeIncomplete, true);
  assert.ok(result.diagnostics.some((item) => item.code === "file_bound_route"));
});

test("route resolution ambiguity and deterministic repeated runs remain explicit", () => {
  const first = symbol("first", "FirstController.list");
  const second = symbol("second", "SecondController.list");
  const graph: CodeGraph = { nodes: [first, second], edges: [] };
  const routeA = routeFixture("nestjs", "/users", "GET", first);
  const routeB = routeFixture("nestjs", "/users", "GET", second);
  const frameworkProjection = projection(graph, [routeA.relationship, routeB.relationship], [routeA.entity, routeB.entity]);
  const entry = { kind: "route" as const, framework: "nestjs" as const, path: "/users", method: "GET" };
  const result = discoverExecutionFlow(graph, frameworkProjection, entry);
  assert.equal(result.status, "ambiguous");
  assert.deepEqual(
    JSON.stringify(discoverExecutionFlow(graph, projection(graph, [routeA.relationship], [routeA.entity]), { ...entry, path: "/users" })),
    JSON.stringify(discoverExecutionFlow(graph, projection(graph, [routeA.relationship], [routeA.entity]), { ...entry, path: "/users" })),
  );
});
