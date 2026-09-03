import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildFileGraphs } from "../src/core/graph/build-file-updates.js";
import { buildCodeGraph } from "../src/core/graph/build-graph.js";
import { expandGraphContext } from "../src/core/graph/expand.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import type { CodeGraph, GraphNode } from "../src/core/graph/types.js";
import { createFileHash } from "../src/core/repository/file-hash.js";
import { getRepoId, scanRepo } from "../src/core/repository/repository-files.js";

async function withRepo(
  files: Record<string, string>,
  callback: (repoPath: string) => Promise<void>,
): Promise<void> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-rag-graph-"));

  try {
    for (const [file, source] of Object.entries(files)) {
      const filePath = path.join(repoPath, file);
      await mkdir(path.dirname(filePath), { recursive: true });
      await writeFile(filePath, source);
    }

    await callback(repoPath);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
}

function findNode(
  graph: CodeGraph,
  file: string,
  type: GraphNode["type"],
  qualifiedName: string,
): GraphNode {
  const node = graph.nodes.find(
    (candidate) =>
      candidate.file === file &&
      candidate.type === type &&
      candidate.qualifiedName === qualifiedName,
  );

  assert.ok(node, `Missing ${file} ${type}:${qualifiedName}`);

  return node;
}

function hasEdge(
  graph: CodeGraph,
  from: GraphNode,
  to: GraphNode,
  type: string,
): boolean {
  return graph.edges.some(
    (edge) =>
      edge.from === from.id && edge.to === to.id && edge.type === type,
  );
}

async function fileHashes(
  repoPath: string,
  files: Set<string>,
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();

  for (const file of files) {
    hashes.set(
      file,
      createFileHash(await readFile(path.join(repoPath, file), "utf8")),
    );
  }

  return hashes;
}

test("resolves constructor parameter properties and local extends", async () => {
  await withRepo(
    {
      "store.ts": `export class GraphStore { loadGraph() {} }`,
      "foo.ts": `
        import { GraphStore } from "./store.js";
        class Foo {
          constructor(private readonly store?: GraphStore) {}
          run() { this.store.loadGraph(); }
        }
        class PublicFoo {
          constructor(public readonly store: GraphStore) {}
          run() { this.store.loadGraph(); }
        }
        class ProtectedFoo {
          constructor(protected store: GraphStore) {}
          run() { this.store.loadGraph(); }
        }
        class Parent {}
        class Child extends Parent {}
      `,
    },
    async (repoPath) => {
      const graph = await buildCodeGraph(repoPath);
      const run = findNode(graph, "foo.ts", "method", "Foo.run");
      const publicRun = findNode(
        graph,
        "foo.ts",
        "method",
        "PublicFoo.run",
      );
      const protectedRun = findNode(
        graph,
        "foo.ts",
        "method",
        "ProtectedFoo.run",
      );
      const loadGraph = findNode(
        graph,
        "store.ts",
        "method",
        "GraphStore.loadGraph",
      );
      const child = findNode(graph, "foo.ts", "class", "Child");
      const parent = findNode(graph, "foo.ts", "class", "Parent");

      assert.ok(hasEdge(graph, run, loadGraph, "calls"));
      assert.ok(hasEdge(graph, publicRun, loadGraph, "calls"));
      assert.ok(hasEdge(graph, protectedRun, loadGraph, "calls"));
      assert.ok(hasEdge(graph, child, parent, "extends"));
      assert.equal(
        graph.edges.length,
        new Set(graph.edges.map((edge) => [edge.from, edge.to, edge.type].join(":"))).size,
      );
    },
  );
});

test("resolves extends from a relative import", async () => {
  await withRepo(
    {
      "parent.ts": `export class Parent {}`, 
      "child.ts": `import { Parent as Base } from "./parent.js"; class Child extends Base {}`,
    },
    async (repoPath) => {
      const graph = await buildCodeGraph(repoPath);
      const child = findNode(graph, "child.ts", "class", "Child");
      const parent = findNode(graph, "parent.ts", "class", "Parent");

      assert.ok(hasEdge(graph, child, parent, "extends"));
    },
  );
});

test("keeps incremental graph updates consistent", async () => {
  await withRepo(
    {
      "store.ts": `export class GraphStore { loadGraph() {} }`,
      "foo.ts": `
        import { GraphStore } from "./store.js";
        export class Foo {
          constructor(private store: GraphStore) {}
          run() { this.store.loadGraph(); }
        }
      `,
    },
    async (repoPath) => {
      const repoId = getRepoId(repoPath);
      const dbPath = path.join(repoPath, "atlas.db");
      const store = new AtlasStore(dbPath);

      try {
        const allFiles = new Set(
          (await scanRepo(repoPath)).map((file) => path.relative(repoPath, file)),
        );
        const initial = await buildCodeGraph(repoPath);
        await store.replaceGraph(
          repoId,
          initial,
          await fileHashes(repoPath, allFiles),
        );

        const unchanged = await buildFileGraphs(
          repoPath,
          repoId,
          [],
          allFiles,
          initial,
        );
        assert.deepEqual(unchanged, []);

        await writeFile(
          path.join(repoPath, "store.ts"),
          `export class GraphStore { saveGraph() {} }`,
        );
        const changedFiles = ["store.ts", "foo.ts"];
        const changed = await buildFileGraphs(
          repoPath,
          repoId,
          changedFiles,
          allFiles,
          initial,
        );
        await store.applyFileUpdates(
          repoId,
          await Promise.all(
            changed.map(async (update) => ({
              ...update,
              fileHash: createFileHash(
                await readFile(path.join(repoPath, update.file), "utf8"),
              ),
            })),
          ),
          [],
        );

        let graph = store.loadGraph(repoId);
        const run = findNode(graph, "foo.ts", "method", "Foo.run");
        const saveGraph = findNode(
          graph,
          "store.ts",
          "method",
          "GraphStore.saveGraph",
        );
        assert.ok(hasEdge(graph, run, saveGraph, "calls") === false);

        await rm(path.join(repoPath, "store.ts"));
        const afterDelete = await buildFileGraphs(
          repoPath,
          repoId,
          ["foo.ts"],
          new Set(["foo.ts"]),
          graph,
        );
        await store.applyFileUpdates(
          repoId,
          afterDelete.map((update) => ({
            ...update,
            fileHash: createFileHash(update.nodes.map((node) => node.id).join("")),
          })),
          ["store.ts"],
        );

        graph = store.loadGraph(repoId);
        assert.equal(graph.nodes.some((node) => node.file === "store.ts"), false);
        assert.equal(graph.edges.some((edge) => edge.type === "calls"), false);
      } finally {
        store.close();
      }
    },
  );
});

test("expands graph context with deterministic caps and call priority", () => {
  const graph: CodeGraph = {
    nodes: [
      { id: "seed", type: "function", name: "seed", file: "a.ts" },
      { id: "callee", type: "function", name: "callee", file: "a.ts" },
      { id: "caller", type: "function", name: "caller", file: "b.ts" },
      { id: "file", type: "file", name: "a.ts", file: "a.ts" },
    ],
    edges: [
      { from: "seed", to: "file", type: "contains" },
      { from: "seed", to: "callee", type: "calls" },
      { from: "caller", to: "seed", type: "calls" },
    ],
  };

  const expanded = expandGraphContext(
    graph,
    [{ file: "a.ts", symbolName: "seed", symbolType: "function" }],
    { maxDepth: 1, maxNodes: 2 },
  );

  assert.deepEqual(
    expanded.map((node) => node.id),
    ["callee", "caller"],
  );
});
