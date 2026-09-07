import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCandidateGeneration } from "../src/core/indexing/index-manifest.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

const versions = {
  schemaVersion: "2",
  factsVersion: "1",
  resolutionVersion: "1",
  derivedVersion: "1",
};

function graph(file: string, name: string) {
  return {
    nodes: [{ id: `${file}:${name}`, type: "function" as const, name, file }],
    edges: [],
  };
}

test("candidate graph and manifest stay invisible until atomic publication", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-generation-"));
  const repoPath = path.join(root, "repo");
  const databasePath = path.join(root, "atlas.db");

  try {
    await writeFile(path.join(root, "seed.txt"), "test");
    const store = new AtlasStore(databasePath);
    const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
    const first = createCandidateGeneration(repository.id, undefined, versions, []);
    store.beginCandidateGeneration(first);
    store.writeCandidateManifest(first.manifest);
    store.writeCandidateGraph(first.id, graph("a.ts", "old"), new Map([["a.ts", "hash-a"]]));
    store.publishCandidateGeneration(first.id);

    assert.equal(store.getActiveGenerationId(repository.id), first.id);
    assert.equal(store.loadGraph(repository.id).nodes[0]?.name, "old");

    const second = createCandidateGeneration(repository.id, first.id, versions, []);
    store.beginCandidateGeneration(second);
    store.writeCandidateManifest(second.manifest);
    store.writeCandidateGraph(second.id, graph("b.ts", "new"), new Map([["b.ts", "hash-b"]]));

    assert.equal(store.getActiveGenerationId(repository.id), first.id);
    assert.equal(store.loadGraph(repository.id).nodes[0]?.name, "old");
    assert.deepEqual(store.getGenerationManifest(repository.id)?.generationId, first.id);

    store.publishCandidateGeneration(second.id);
    assert.equal(store.getActiveGenerationId(repository.id), second.id);
    assert.equal(store.loadGraph(repository.id).nodes[0]?.name, "new");
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("failed candidate leaves the active generation and candidate unreadable", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-generation-failure-"));
  const repoPath = path.join(root, "repo");
  const databasePath = path.join(root, "atlas.db");

  try {
    const store = new AtlasStore(databasePath);
    const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
    const candidate = createCandidateGeneration(repository.id, undefined, versions, []);
    store.beginCandidateGeneration(candidate);
    store.writeCandidateManifest(candidate.manifest);
    store.writeCandidateGraph(candidate.id, graph("candidate.ts", "candidate"), new Map([["candidate.ts", "hash"]]));
    assert.throws(() => store.publishCandidateGeneration(candidate.id, { requireGraph: true, requireLexical: true }));
    assert.equal(store.getActiveGenerationId(repository.id), undefined);
    assert.deepEqual(store.loadGraph(repository.id), { nodes: [], edges: [] });
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
