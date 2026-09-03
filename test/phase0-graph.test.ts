import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { buildCodeGraph } from "../src/core/graph/build-graph.js";
import type { CodeGraph, GraphNode } from "../src/core/graph/types.js";

const fixturePath = fileURLToPath(new URL("./fixtures/phase-0-graph", import.meta.url));

async function withFixture(callback: (repoPath: string) => Promise<void>): Promise<void> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-0-graph-"));

  try {
    await cp(fixturePath, repoPath, { recursive: true });
    await callback(repoPath);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
}

function node(graph: CodeGraph, file: string, type: GraphNode["type"], qualifiedName: string): GraphNode {
  const result = graph.nodes.find(
    (candidate) =>
      candidate.file === file &&
      candidate.type === type &&
      candidate.qualifiedName === qualifiedName,
  );

  assert.ok(result, `Missing ${file} ${type}:${qualifiedName}`);
  return result;
}

function hasCall(graph: CodeGraph, from: GraphNode, to: GraphNode): boolean {
  return graph.edges.some(
    (edge) => edge.type === "calls" && edge.from === from.id && edge.to === to.id,
  );
}

function hasRelation(graph: CodeGraph, from: GraphNode, to: GraphNode, type: "extends"): boolean {
  return graph.edges.some(
    (edge) => edge.type === type && edge.from === from.id && edge.to === to.id,
  );
}

test("Phase 0 freezes supported graph resolution and qualified identities", async () => {
  await withFixture(async (repoPath) => {
    const graph = await buildCodeGraph(repoPath);
    const target = node(graph, "target.ts", "function", "importedTarget");
    const serviceMethod = node(graph, "target.ts", "method", "Service.method");

    assert.ok(hasCall(
      graph,
      node(graph, "graph.ts", "function", "localCaller"),
      node(graph, "graph.ts", "function", "localTarget"),
    ));
    assert.ok(hasCall(
      graph,
      node(graph, "graph.ts", "function", "localCaller"),
      target,
    ));
    assert.ok(hasCall(
      graph,
      node(graph, "graph.ts", "method", "Receiver.callThis"),
      node(graph, "graph.ts", "method", "Receiver.helper"),
    ));
    assert.ok(hasCall(
      graph,
      node(graph, "graph.ts", "function", "typedCaller"),
      serviceMethod,
    ));
    assert.ok(hasCall(
      graph,
      node(graph, "graph.ts", "method", "Receiver.callField"),
      serviceMethod,
    ));
    assert.ok(hasCall(
      graph,
      node(graph, "graph.ts", "method", "Receiver.callParameterProperty"),
      serviceMethod,
    ));
    assert.ok(hasCall(
      graph,
      node(graph, "graph.ts", "function", "newCaller"),
      serviceMethod,
    ));
    assert.ok(hasCall(
      graph,
      node(graph, "graph.ts", "function", "directNewCaller"),
      serviceMethod,
    ));
    assert.ok(hasRelation(
      graph,
      node(graph, "graph.ts", "class", "LocalChild"),
      node(graph, "graph.ts", "class", "LocalParent"),
      "extends",
    ));
    assert.ok(hasRelation(
      graph,
      node(graph, "graph.ts", "class", "ImportedChild"),
      node(graph, "target.ts", "class", "Parent"),
      "extends",
    ));

    const duplicateNames = graph.nodes
      .filter((candidate) => candidate.file === "graph.ts" && candidate.name === "duplicate")
      .map((candidate) => candidate.qualifiedName)
      .sort();

    assert.deepEqual(duplicateNames, [
      "OuterA.run.duplicate",
      "OuterB.run.duplicate",
    ]);
    assert.equal(
      new Set(graph.nodes.map((candidate) => candidate.id)).size,
      graph.nodes.length,
    );
  });
});

test("Phase 0 keeps graph identities deterministic across rebuilds", async () => {
  await withFixture(async (repoPath) => {
    const first = await buildCodeGraph(repoPath);
    const second = await buildCodeGraph(repoPath);

    assert.deepEqual(second, first);
  });
});
