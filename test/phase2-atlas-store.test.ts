import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import {
  canonicalRepositoryPath,
  getRepositoryIdentity,
} from "../src/core/repository/repository-identity.js";
import type { CodeGraph } from "../src/core/graph/types.js";

const graph: CodeGraph = {
  nodes: [
    { id: "file", type: "file", name: "a.ts", file: "a.ts" },
    { id: "fn", type: "function", name: "a", qualifiedName: "a", file: "a.ts" },
  ],
  edges: [{ from: "file", to: "fn", type: "contains" }],
};

function canonicalGraph(value: CodeGraph): string {
  return JSON.stringify({
    nodes: value.nodes
      .map((node) => ({
        id: node.id,
        type: node.type,
        name: node.name,
        qualifiedName: node.qualifiedName ?? node.name,
        file: node.file,
        startLine: node.startLine,
        endLine: node.endLine,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: value.edges.sort((a, b) =>
      [a.from, a.to, a.type].join(":").localeCompare([b.from, b.to, b.type].join(":")),
    ),
  });
}

async function tempRepo(name: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `code-atlas-phase-2-${name}-`));
}

test("AtlasStore creates ignored local state and reopens the same repository identity", async () => {
  const repoPath = await tempRepo("identity");
  const databasePath = path.join(repoPath, ".codeatlas", "atlas.db");

  try {
    const firstStore = new AtlasStore(databasePath);
    const first = firstStore.ensureRepository(getRepositoryIdentity(repoPath));
    firstStore.setVersion(first.id, "parser", "parser-1");
    firstStore.close();

    assert.equal(await readFile(path.join(repoPath, ".codeatlas", ".gitignore"), "utf8"), "*\n!.gitignore\n");

    const secondStore = new AtlasStore(databasePath);
    const second = secondStore.ensureRepository(getRepositoryIdentity(repoPath));
    assert.equal(second.id, first.id);
    assert.equal(second.rootPath, canonicalRepositoryPath(repoPath));
    assert.equal(secondStore.getMetadata(second.id, "parser")?.version, "parser-1");
    secondStore.close();
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("AtlasStore isolates repositories with the same basename and preserves graph metadata", async () => {
  const root = await tempRepo("isolation");
  const repoA = path.join(root, "same-name");
  const repoB = path.join(root, "other", "same-name");
  const databasePath = path.join(root, "atlas.db");
  const store = new AtlasStore(databasePath);

  try {
    const a = store.ensureRepository(getRepositoryIdentity(repoA));
    const b = store.ensureRepository(getRepositoryIdentity(repoB));
    assert.notEqual(a.id, b.id);

    store.replaceGraph(a.id, graph, new Map([["a.ts", "hash-a"]]), "graph-1");
    assert.equal(canonicalGraph(store.loadGraph(a.id)), canonicalGraph(graph));
    assert.deepEqual(store.loadGraph(b.id), { nodes: [], edges: [] });
    assert.equal(store.getVersion(a.id, "graph"), "graph-1");
    for (const [axis, version] of [
      ["lexical", "lexical-1"],
      ["semantic", "semantic-1"],
      ["metrics", "metrics-1"],
    ] as const) {
      store.setVersion(a.id, axis, version);
      assert.equal(store.getVersion(a.id, axis), version);
    }
    assert.deepEqual(store.getFileStates(a.id), new Map([["a.ts", { fileHash: "hash-a" }]]));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("AtlasStore records zero-item, stale, disabled, and error capability states", async () => {
  const repoPath = await tempRepo("capabilities");
  const store = new AtlasStore(path.join(repoPath, "atlas.db"));

  try {
    const repo = store.ensureRepository(getRepositoryIdentity(repoPath));
    store.setFileCapabilityState(repo.id, "empty.ts", "semantic", {
      version: "semantic-1",
      state: "ready",
      generation: "generation-1",
      itemCount: 0,
      fileHash: "empty-hash",
    });
    store.setFileCapabilityState(repo.id, "stale.ts", "graph", {
      version: "graph-1",
      state: "stale",
      itemCount: 0,
      fileHash: "stale-hash",
    });
    store.setFileCapabilityState(repo.id, "disabled.ts", "semantic", {
      version: "semantic-1",
      state: "disabled",
      itemCount: 0,
    });
    store.setFileCapabilityState(repo.id, "error.ts", "semantic", {
      version: "semantic-1",
      state: "error",
      itemCount: 0,
      lastError: "embedding failed",
    });

    assert.equal(store.getFileCapabilityState(repo.id, "empty.ts", "semantic")?.itemCount, 0);
    assert.equal(store.getFileCapabilityState(repo.id, "stale.ts", "graph")?.state, "stale");
    assert.equal(store.getFileCapabilityState(repo.id, "disabled.ts", "semantic")?.state, "disabled");
    assert.equal(store.getFileCapabilityState(repo.id, "error.ts", "semantic")?.lastError, "embedding failed");
  } finally {
    store.close();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("AtlasStore rejects an unsupported schema version and leaves legacy .code-rag untouched", async () => {
  const repoPath = await tempRepo("compatibility");
  const databasePath = path.join(repoPath, "atlas.db");
  const legacyPath = path.join(repoPath, ".code-rag", "marker");

  try {
    await mkdir(path.dirname(legacyPath), { recursive: true });
    await writeFile(legacyPath, "legacy");
    const database = new DatabaseSync(databasePath);
    database.exec("CREATE TABLE atlas_schema (id INTEGER PRIMARY KEY, version TEXT NOT NULL);");
    database.prepare("INSERT INTO atlas_schema (id, version) VALUES (1, '999')").run();
    database.close();

    assert.throws(() => new AtlasStore(databasePath), /Unsupported AtlasStore schema version: 999/);
    assert.equal(await readFile(legacyPath, "utf8"), "legacy");
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
