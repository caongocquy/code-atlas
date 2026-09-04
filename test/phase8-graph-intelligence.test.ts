import assert from "node:assert/strict";
import test from "node:test";

import { findCallees, findCallers, findImportedBy, findImports } from "../src/core/graph/query/graph-query.service.js";
import { GraphQueryEntityResolver } from "../src/core/graph/query/graph-query-entity-resolver.js";
import { analyzeImpact } from "../src/core/graph/query/impact.service.js";
import { traceGraph } from "../src/core/graph/query/trace.service.js";
import type { CodeGraph, GraphNode } from "../src/core/graph/types.js";

const nodes: GraphNode[] = [
  { id: "file-a", type: "file", name: "src/a.ts", qualifiedName: "src/a.ts", file: "src/a.ts" },
  { id: "file-b", type: "file", name: "src/b.ts", qualifiedName: "src/b.ts", file: "src/b.ts" },
  { id: "file-other-a", type: "file", name: "other/a.ts", qualifiedName: "other/a.ts", file: "other/a.ts" },
  { id: "file-c", type: "file", name: "src/c.ts", qualifiedName: "src/c.ts", file: "src/c.ts" },
  { id: "target", type: "function", name: "target", qualifiedName: "target", file: "src/a.ts", startLine: 2 },
  { id: "target-helper", type: "function", name: "targetHelper", qualifiedName: "targetHelper", file: "src/c.ts", startLine: 2 },
  { id: "helper", type: "function", name: "helper", qualifiedName: "helper", file: "src/a.ts", startLine: 3 },
  { id: "caller", type: "function", name: "caller", qualifiedName: "caller", file: "src/b.ts", startLine: 2 },
  { id: "source", type: "function", name: "source", qualifiedName: "source", file: "src/b.ts", startLine: 3 },
  { id: "duplicate-a", type: "function", name: "duplicate", qualifiedName: "A.duplicate", file: "src/a.ts", startLine: 5 },
  { id: "duplicate-b", type: "function", name: "duplicate", qualifiedName: "B.duplicate", file: "src/b.ts", startLine: 5 },
  { id: "auth", type: "class", name: "AuthService", qualifiedName: "AuthService", file: "src/a.ts", startLine: 8 },
  { id: "base", type: "class", name: "Base", qualifiedName: "Base", file: "src/a.ts", startLine: 10 },
  { id: "child", type: "class", name: "Child", qualifiedName: "Child", file: "src/b.ts", startLine: 10 },
  { id: "isolated", type: "function", name: "isolated", qualifiedName: "isolated", file: "src/c.ts", startLine: 1 },
];

const graph: CodeGraph = {
  nodes,
  edges: [
    { from: "helper", to: "target", type: "calls", resolutionMethod: "same_file", evidenceKind: "INFERRED", confidence: 1, resolutionSource: { file: "src/a.ts", line: 3 } },
    { from: "caller", to: "helper", type: "calls", resolutionMethod: "import_binding", evidenceKind: "INFERRED", confidence: 1, resolutionSource: { file: "src/b.ts", line: 2 } },
    { from: "source", to: "caller", type: "calls", resolutionMethod: "same_file", evidenceKind: "INFERRED", confidence: 1, resolutionSource: { file: "src/b.ts", line: 3 } },
    { from: "target", to: "isolated", type: "calls" },
    { from: "file-b", to: "file-a", type: "imports" },
    { from: "child", to: "base", type: "extends", resolutionMethod: "inheritance", evidenceKind: "INFERRED", confidence: 1, resolutionSource: { file: "src/b.ts", line: 10 } },
  ],
};

test("GraphQueryEntityResolver ranks exact and contextual matches deterministically", () => {
  const resolver = new GraphQueryEntityResolver(graph);
  assert.equal(resolver.resolve("A.duplicate").status, "resolved");
  assert.equal(resolver.resolve("A.duplicate").status === "resolved" && resolver.resolve("A.duplicate").entity.id, "duplicate-a");
  assert.equal(resolver.resolve("duplicate").status, "ambiguous");
  assert.equal(resolver.resolve("src/a.ts:duplicate").status, "resolved");
  assert.equal(resolver.resolve("src/a.ts:duplicate").status === "resolved" && resolver.resolve("src/a.ts:duplicate").entity.id, "duplicate-a");
  assert.equal(resolver.resolve("auth_service").status === "resolved" && resolver.resolve("auth_service").entity.id, "auth");
  assert.equal(resolver.resolve("target").status === "resolved" && resolver.resolve("target").entity.id, "target");
  assert.equal(resolver.resolve("targetH").status === "resolved" && resolver.resolve("targetH").entity.id, "target-helper");
  assert.equal(resolver.resolve("src/a.ts").status === "resolved" && resolver.resolve("src/a.ts").entity.id, "file-a");
  assert.equal(resolver.resolve("other/a.ts").status === "resolved" && resolver.resolve("other/a.ts").entity.id, "file-other-a");
  assert.equal(resolver.resolve("missing").status, "not_found");
  assert.deepEqual(
    resolver.resolve("duplicate").status === "ambiguous"
      ? resolver.resolve("duplicate").candidates.map((candidate) => candidate.entity.id)
      : [],
    ["duplicate-a", "duplicate-b"],
  );
});

test("graph relation helpers preserve edge direction and relation semantics", () => {
  const target = nodes.find((node) => node.id === "target")!;
  const fileA = nodes.find((node) => node.id === "file-a")!;
  assert.equal(findCallers(graph, target)[0]?.entity.id, "helper");
  assert.equal(findCallees(graph, target)[0]?.entity.id, "isolated");
  assert.equal(findImports(graph, nodes.find((node) => node.id === "file-b")!)[0]?.entity.id, "file-a");
  assert.equal(findImportedBy(graph, fileA)[0]?.entity.id, "file-b");
  assert.equal(findCallers(graph, target)[0]?.direction, "inverse");
  assert.equal(findCallees(graph, target)[0]?.direction, "forward");
  assert.equal(findImportedBy(graph, fileA)[0]?.direction, "inverse");
});

test("impact follows reverse dependency edges with deterministic bounds and coverage", () => {
  const result = analyzeImpact(graph, "target", {
    maxDepth: 2,
    maxResults: 10,
    coverage: { mayBeIncomplete: true },
  });
  assert.equal(result.status, "resolved");
  if (result.status !== "resolved") return;
  assert.deepEqual(result.directImpact.map((item) => item.entity.id), ["helper"]);
  assert.deepEqual(result.transitiveImpact.map((item) => item.entity.id), ["caller"]);
  assert.equal(result.directImpact[0]?.direction, "inverse");
  assert.equal(result.mayBeIncomplete, true);
  assert.equal(result.summary.totalCount, 2);
  assert.equal(result.risk, "low");

  const bounded = analyzeImpact(graph, "target", { maxDepth: 1, maxResults: 1 });
  assert.equal(bounded.status, "resolved");
  if (bounded.status === "resolved") {
    assert.equal(bounded.directImpact.length, 1);
    assert.equal(bounded.truncated, true);
  }
  const empty = analyzeImpact(graph, "target", { maxResults: 0 });
  assert.equal(empty.status, "resolved");
  if (empty.status === "resolved") {
    assert.equal(empty.summary.totalCount, 0);
    assert.equal(empty.truncated, true);
  }
  assert.equal(analyzeImpact(graph, "duplicate").status, "ambiguous");
  assert.equal(analyzeImpact(graph, "missing").status, "not_found");
  const fileImpact = analyzeImpact(graph, "src/a.ts");
  assert.equal(fileImpact.status, "resolved");
  if (fileImpact.status === "resolved") assert.equal(fileImpact.directImpact.some((item) => item.entity.id === "file-b"), true);
});

test("trace resolves endpoints before bounded deterministic traversal", () => {
  const direct = traceGraph(graph, "source", "target");
  assert.equal(direct.status, "found");
  if (direct.status === "found") {
    assert.deepEqual(direct.path.nodes.map((node) => node.id), ["source", "caller", "helper", "target"]);
    assert.deepEqual(direct.path.hops.map((hop) => hop.relation), ["calls", "calls", "calls"]);
    assert.equal(direct.path.hops[1]?.edge.resolutionMethod, "import_binding");
  }

  const inverse = traceGraph(graph, "target", "source", { mode: "explanatory" });
  assert.equal(inverse.status, "found");
  if (inverse.status === "found") assert.deepEqual(inverse.path.hops.map((hop) => hop.direction), ["inverse", "inverse", "inverse"]);
  assert.equal(traceGraph(graph, "target", "source").status, "no_path");
  assert.equal(traceGraph(graph, "source", "target", { maxDepth: 2 }).status, "no_path");
  assert.equal(traceGraph(graph, "target", "target").status, "found");
  assert.equal(traceGraph(graph, "duplicate", "target").status, "ambiguous");
  assert.equal(traceGraph(graph, "isolated", "target").status, "no_path");
  assert.equal(traceGraph(graph, "child", "base").status, "found");
  assert.equal(traceGraph(graph, "src/b.ts", "src/a.ts").status, "found");
  const cyclicGraph = { ...graph, edges: [...graph.edges, { from: "target", to: "source", type: "calls" as const }] };
  assert.equal(traceGraph(cyclicGraph, "source", "child").status, "no_path");
});
