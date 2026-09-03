import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { GraphStore } from "../src/storage/graph/graph.store.js";
import type { CodeGraph } from "../src/core/graph/types.js";

function canonicalGraph(graph: CodeGraph): string {
  return JSON.stringify({
    nodes: [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graph.edges].sort((a, b) =>
      [a.from, a.to, a.type].join(":").localeCompare([b.from, b.to, b.type].join(":")),
    ),
  });
}

test("GraphStore rolls back a failing replacement without partial state", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-0-store-"));
  const dbPath = path.join(repoPath, "graph.db");
  const repoId = "phase-0-repo";
  const committed: CodeGraph = {
    nodes: [
      { id: "file-a", type: "file", name: "a.ts", qualifiedName: "a.ts", file: "a.ts" },
      { id: "fn-a", type: "function", name: "a", qualifiedName: "a", file: "a.ts" },
    ],
    edges: [{ from: "file-a", to: "fn-a", type: "contains" }],
  };
  const failing: CodeGraph = {
    nodes: [{ id: "file-b", type: "file", name: "b.ts", file: "b.ts" }],
    edges: [{ from: "missing", to: "file-b", type: "contains" }],
  };

  try {
    const store = new GraphStore(dbPath);

    try {
      store.replaceGraph(repoId, committed, new Map([["a.ts", "hash-a"]]));
      assert.throws(
        () => store.replaceGraph(repoId, failing, new Map([["b.ts", "hash-b"]])),
        /Missing source node for edge: missing/,
      );
      assert.deepEqual(
        JSON.parse(canonicalGraph(store.loadGraph(repoId))),
        JSON.parse(canonicalGraph(committed)),
      );
      assert.deepEqual(store.getFileStates(repoId), new Map([["a.ts", { fileHash: "hash-a" }]]));
    } finally {
      store.close();
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
