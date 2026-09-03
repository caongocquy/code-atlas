import test from "node:test";
import assert from "node:assert/strict";

import {
  getGraphOverview,
  getIndexedGraphFiles,
  getGraphNeighborhood,
  searchGraphNodes,
} from "../src/core/graph/explorer.js";
import type { CodeGraph } from "../src/core/graph/types.js";
import { resolveRepoSourcePath } from "../src/adapters/http/repository-source-path.js";

const graph: CodeGraph = {
  nodes: [
    { id: "a", type: "function", name: "alpha", file: "a.ts", qualifiedName: "alpha" },
    { id: "b", type: "function", name: "beta", file: "b.ts", qualifiedName: "beta" },
    { id: "c", type: "class", name: "Container", file: "c.ts", qualifiedName: "Container" },
  ],
  edges: [
    { from: "a", to: "b", type: "calls" },
    { from: "b", to: "c", type: "contains" },
  ],
};

test("graph inspector searches deterministically and bounds neighborhoods", () => {
  assert.deepEqual(searchGraphNodes(graph, "alpha").map((node) => node.id), ["a"]);

  const neighborhood = getGraphNeighborhood(graph, "a", {
    depth: 2,
    maxNodes: 2,
    edgeTypes: ["calls", "contains"],
  });

  assert.equal(neighborhood.nodes.length, 2);
  assert.deepEqual(neighborhood.nodes.map((node) => node.id), ["a", "b"]);
  assert.equal(neighborhood.edges.length, 1);
});

test("graph overview and indexed files are deterministic and bounded", () => {
  const overview = getGraphOverview({
    nodes: [
      { id: "b", type: "function", name: "b", file: "b.ts" },
      { id: "file-a", type: "file", name: "a.ts", file: "a.ts" },
      { id: "a", type: "function", name: "a", file: "a.ts" },
    ],
    edges: [
      { from: "a", to: "b", type: "calls" },
      { from: "file-a", to: "a", type: "contains" },
    ],
  }, 2);

  assert.equal(overview.totalNodes, 3);
  assert.equal(overview.truncated, true);
  assert.deepEqual(overview.nodes.map((node) => node.id), ["a", "b"]);
  assert.deepEqual(overview.edges, [{ from: "a", to: "b", type: "calls" }]);

  assert.deepEqual(getIndexedGraphFiles({
    nodes: [
      { id: "file-b", type: "file", name: "b.ts", file: "b.ts" },
      { id: "b", type: "function", name: "b", file: "b.ts" },
      { id: "file-a", type: "file", name: "a.ts", file: "a.ts" },
      { id: "a", type: "function", name: "a", file: "a.ts" },
    ],
    edges: [],
  }), [
    { path: "a.ts", nodeId: "file-a", symbols: 1 },
    { path: "b.ts", nodeId: "file-b", symbols: 1 },
  ]);
});

test("source path resolution stays inside the repository", () => {
  assert.equal(resolveRepoSourcePath("/repo", "src/index.ts"), "/repo/src/index.ts");
  assert.throws(() => resolveRepoSourcePath("/repo", "../package.json"), /outside the repository/);
});
