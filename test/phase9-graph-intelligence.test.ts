import assert from "node:assert/strict";
import test from "node:test";

import { detectArchitecturalBridges } from "../src/core/graph/intelligence/bridges.service.js";
import { detectCommunities } from "../src/core/graph/intelligence/communities.service.js";
import { detectStructuralCycles } from "../src/core/graph/intelligence/cycles.service.js";
import { analyzeGraphIntelligence } from "../src/core/graph/intelligence/graph-intelligence.service.js";
import { calculateImportance } from "../src/core/graph/intelligence/importance.service.js";
import type { CodeGraph, GraphNode } from "../src/core/graph/types.js";

const nodes: GraphNode[] = [
  { id: "file-a", type: "file", name: "src/a.ts", qualifiedName: "src/a.ts", file: "src/a.ts" },
  { id: "file-b", type: "file", name: "src/b.ts", qualifiedName: "src/b.ts", file: "src/b.ts" },
  { id: "file-isolated", type: "file", name: "src/isolated.ts", qualifiedName: "src/isolated.ts", file: "src/isolated.ts" },
  { id: "core", type: "class", name: "CoreService", qualifiedName: "CoreService", file: "src/a.ts", startLine: 2 },
  { id: "a-helper", type: "function", name: "aHelper", qualifiedName: "aHelper", file: "src/a.ts", startLine: 8 },
  { id: "a-entry", type: "function", name: "aEntry", qualifiedName: "aEntry", file: "src/a.ts", startLine: 12 },
  { id: "b-entry", type: "function", name: "bEntry", qualifiedName: "bEntry", file: "src/b.ts", startLine: 2 },
  { id: "b-helper", type: "function", name: "bHelper", qualifiedName: "bHelper", file: "src/b.ts", startLine: 8 },
  { id: "isolated", type: "function", name: "isolated", qualifiedName: "isolated", file: "src/isolated.ts", startLine: 1 },
  { id: "utils", type: "function", name: "utils", qualifiedName: "utils", file: "src/a.ts", startLine: 20 },
  ...Array.from({ length: 8 }, (_, index) => ({
    id: `local-${index}`,
    type: "function" as const,
    name: `local${index}`,
    qualifiedName: `local${index}`,
    file: "src/a.ts",
  })),
  { id: "generated", type: "function", name: "generated", qualifiedName: "generated", file: "dist/generated.ts" },
];

const graph: CodeGraph = {
  nodes,
  edges: [
    { from: "file-a", to: "a-helper", type: "contains" },
    { from: "file-a", to: "a-entry", type: "contains" },
    { from: "file-a", to: "core", type: "contains" },
    { from: "file-a", to: "utils", type: "contains" },
    { from: "file-b", to: "b-entry", type: "contains" },
    { from: "file-b", to: "b-helper", type: "contains" },
    { from: "file-isolated", to: "isolated", type: "contains" },
    { from: "a-entry", to: "a-helper", type: "calls", confidence: 1, evidenceKind: "EXTRACTED", resolutionMethod: "same_file", resolutionSource: { file: "src/a.ts", line: 12 } },
    { from: "a-helper", to: "core", type: "calls", confidence: 1, evidenceKind: "INFERRED", resolutionMethod: "same_file", resolutionSource: { file: "src/a.ts", line: 8 } },
    { from: "b-entry", to: "b-helper", type: "calls", confidence: 1, evidenceKind: "EXTRACTED", resolutionMethod: "same_file", resolutionSource: { file: "src/b.ts", line: 2 } },
    { from: "b-helper", to: "core", type: "calls", confidence: 0.9, evidenceKind: "INFERRED", resolutionMethod: "import_binding", resolutionSource: { file: "src/b.ts", line: 8 } },
    { from: "file-b", to: "file-a", type: "imports", confidence: 1, evidenceKind: "EXTRACTED", resolutionMethod: "import_binding", resolutionSource: { file: "src/b.ts", line: 1 } },
    ...Array.from({ length: 8 }, (_, index) => ({ from: `local-${index}`, to: "utils", type: "calls" as const })),
    { from: "utils", to: "generated", type: "calls" },
  ],
};

const architectureGraph: CodeGraph = {
  nodes: nodes.filter((node) => !node.id.startsWith("local-") && node.id !== "utils" && node.id !== "generated"),
  edges: graph.edges.filter((edge) => !edge.from.startsWith("local-") && edge.from !== "utils" && edge.to !== "utils" && edge.to !== "generated"),
};

test("importance combines normalized signals, suppresses local hubs, and is stable", () => {
  const first = calculateImportance(graph, { limit: 100, coverage: { mayBeIncomplete: true } });
  const reordered = calculateImportance({ nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse() }, { limit: 100 });
  assert.deepEqual(first.items.map((item) => [item.symbol.id, item.score, item.rank]), reordered.items.map((item) => [item.symbol.id, item.score, item.rank]));
  assert.equal(first.mayBeIncomplete, true);
  assert.equal(first.items.some((item) => item.symbol.type === "file"), false);
  assert.equal(first.items.find((item) => item.symbol.id === "core")!.signals.crossFileReach > 0, true);
  assert.equal(first.items.find((item) => item.symbol.id === "utils")!.signals.suppressionReasons.includes("generic-high-degree-name"), true);
  assert.equal(first.items.find((item) => item.symbol.id === "utils")!.score < first.items.find((item) => item.symbol.id === "core")!.score, true);
  assert.equal(first.items.find((item) => item.symbol.id === "generated")!.signals.noisePenalty < 1, true);
  const tieGraph: CodeGraph = {
    nodes: [
      { id: "z", type: "function", name: "z", file: "src/z.ts" },
      { id: "a", type: "function", name: "a", file: "src/a.ts" },
    ],
    edges: [],
  };
  assert.deepEqual(calculateImportance(tieGraph, { limit: 2 }).items.map((item) => item.symbol.id), ["a", "z"]);
  assert.equal(calculateImportance({ nodes: graph.nodes.filter((node) => node.file.startsWith("src/b")), edges: [] }).items.some((item) => item.symbol.file.startsWith("src/a")), false);
});

test("communities are deterministic, stable by member hash, and preserve useful small groups", () => {
  const first = detectCommunities(architectureGraph, { maxResults: 10_000, includeSingletons: true });
  const second = detectCommunities({ nodes: [...architectureGraph.nodes].reverse(), edges: [...architectureGraph.edges].reverse() }, { maxResults: 10_000, includeSingletons: true });
  assert.deepEqual(first.communities.map((community) => [community.id, community.memberIds, community.quality]), second.communities.map((community) => [community.id, community.memberIds, community.quality]));
  assert.equal(first.communities.some((community) => community.memberIds.includes("isolated")), true);
  assert.equal(first.communities.some((community) => community.quality === "singleton"), true);
  assert.equal(first.communities.some((community) => community.size >= 2 && community.externalEdgeCount > 0), true);
  assert.equal(first.coupling.length > 0, true);
  assert.equal(first.coupling.some((coupling) => coupling.edgeCount > 0 && coupling.representativeSymbols.length > 0), true);
  assert.equal(detectCommunities(architectureGraph, { maxCommunitySize: 1 }).communities.some((community) => community.quality === "oversized"), true);
});

test("bridges score sparse cross-community edges and retain evidence", () => {
  const communities = detectCommunities(architectureGraph, { maxResults: 10_000, includeSingletons: true });
  const result = detectArchitecturalBridges(architectureGraph, communities, { limit: 100, coverage: { mayBeIncomplete: true } });
  assert.equal(result.mayBeIncomplete, true);
  assert.equal(result.coupling.length > 0, true);
  assert.equal(result.bridges.length > 0, true);
  assert.equal(result.bridges.every((bridge) => bridge.sourceCommunityId !== bridge.targetCommunityId), true);
  assert.equal(result.bridges.some((bridge) => bridge.edge.evidenceKind === "EXTRACTED" || bridge.edge.evidenceKind === "INFERRED"), true);
  assert.equal(result.bridges[0]!.reason.length > 0, true);
  const noisy = detectArchitecturalBridges(graph, detectCommunities(graph, { maxResults: 10_000, includeSingletons: true }), { limit: 100 });
  assert.equal(noisy.bridges.some((bridge) => bridge.source.id === "utils" || bridge.target.id === "utils"), false);
});

test("cycles remain typed, canonical, bounded, and repository-scoped", () => {
  const cycleGraph: CodeGraph = {
    nodes: [
      { id: "a", type: "function", name: "a", file: "src/a.ts" },
      { id: "b", type: "function", name: "b", file: "src/b.ts" },
      { id: "c", type: "function", name: "c", file: "src/c.ts" },
      { id: "d", type: "function", name: "d", file: "src/d.ts" },
      { id: "e", type: "function", name: "e", file: "src/e.ts" },
    ],
    edges: [
      { from: "a", to: "b", type: "imports" },
      { from: "b", to: "a", type: "imports" },
      { from: "a", to: "b", type: "calls" },
      { from: "b", to: "c", type: "calls" },
      { from: "c", to: "a", type: "calls" },
      { from: "d", to: "e", type: "calls" },
    ],
  };
  const result = detectStructuralCycles(cycleGraph, { maxResults: 10, coverage: { mayBeIncomplete: true } });
  assert.equal(result.mayBeIncomplete, true);
  assert.equal(result.counts.imports, 1);
  assert.equal(result.counts.calls, 1);
  assert.equal(result.cycles.filter((cycle) => cycle.relation === "imports").length, 1);
  assert.equal(result.cycles.filter((cycle) => cycle.relation === "calls").length, 1);
  assert.deepEqual(result.cycles.find((cycle) => cycle.relation === "imports")!.nodes.map((node) => node.id), ["a", "b"]);
  assert.deepEqual(result.cycles.find((cycle) => cycle.relation === "calls")!.nodes.map((node) => node.id), ["a", "b", "c"]);
  assert.equal(detectStructuralCycles(cycleGraph, { maxResults: 1 }).truncated, true);
  assert.equal(detectStructuralCycles({ nodes: [cycleGraph.nodes[0]!], edges: [] }).cycles.length, 0);
});

test("the architecture summary composes current graph intelligence without persistence", () => {
  const summary = analyzeGraphIntelligence(architectureGraph, { coverage: { mayBeIncomplete: true }, importance: { limit: 5 } });
  assert.equal(summary.mayBeIncomplete, true);
  assert.equal(summary.importance.items.length, 5);
  assert.equal(summary.communities.totalCommunities > 0, true);
  assert.equal(summary.bridges.coupling.length > 0, true);
  assert.equal(summary.cycles.cycles.length, 0);
});
