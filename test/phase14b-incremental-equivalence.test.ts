import assert from "node:assert/strict";
import { mkdir, mkdtemp, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import type { CodeGraph } from "../src/core/graph/types.js";

type EquivalenceFixture = {
  root: string;
  dependency: string;
  renamedDependency: string;
};

export async function createEquivalenceFixture(): Promise<EquivalenceFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14b-equivalence-"));
  await mkdir(path.join(root, "src"), { recursive: true });
  await writeFile(path.join(root, "src", "dep.ts"), "export function dep() { return true; }\n");
  await writeFile(path.join(root, "src", "consumer.ts"), 'import { dep } from "./dep.js"; export function run() { return dep(); }\n');
  await writeFile(path.join(root, "src", "unrelated.ts"), "export function stable() { return 1; }\nexport function use() { return stable(); }\n");
  return {
    root,
    dependency: path.join(root, "src", "dep.ts"),
    renamedDependency: path.join(root, "src", "renamed-dep.ts"),
  };
}

export async function applySafeDependencyChange(fixture: EquivalenceFixture): Promise<void> {
  await writeFile(fixture.dependency, "export function dep() { return false; }\n");
}

export async function applyRenamedModuleWithUnknownExport(fixture: EquivalenceFixture): Promise<void> {
  await rename(fixture.dependency, fixture.renamedDependency);
}

function normalizedGraph(graph: CodeGraph) {
  const nodeKeys = new Map(graph.nodes.map((node) => [node.id, `${node.type}:${node.file}:${node.qualifiedName ?? node.name}`]));
  return {
    nodes: graph.nodes
      .map(({ id: _id, ...node }) => node)
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    edges: graph.edges
      .map(({ from, to, ...edge }) => ({ from: nodeKeys.get(from) ?? from, to: nodeKeys.get(to) ?? to, ...edge }))
      .sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
  };
}

export async function normalizedGraphMatchesCleanRebuild(root: string): Promise<boolean> {
  const databasePath = path.join(root, ".codeatlas", "atlas.db");
  const store = new AtlasStore(databasePath);
  const repositoryId = getRepositoryIdentity(root).id;
  const incremental = store.loadGraph(repositoryId);
  store.close();

  await rm(path.join(root, ".codeatlas"), { recursive: true, force: true });
  const clean = await indexRepository(root, { skipGit: true });
  if (clean.kind !== "published") return false;

  const cleanStore = new AtlasStore(databasePath);
  try {
    return JSON.stringify(normalizedGraph(incremental)) === JSON.stringify(normalizedGraph(cleanStore.loadGraph(repositoryId)));
  } finally {
    cleanStore.close();
  }
}

test("incremental normalized graph equals clean rebuild after safe change, rename, and unsafe move", async () => {
  const fixture = await createEquivalenceFixture();
  try {
    await indexRepository(fixture.root, { skipGit: true });
    await applySafeDependencyChange(fixture);
    const safe = await syncRepository(fixture.root, { skipGit: true });
    assert.equal(safe.kind, "published");
    assert.equal(await normalizedGraphMatchesCleanRebuild(fixture.root), true);

    await applyRenamedModuleWithUnknownExport(fixture);
    const unsafe = await syncRepository(fixture.root, { skipGit: true });
    assert.equal(unsafe.kind, "published");
    assert.equal(unsafe.plan.fullGraphResolution, true);
    assert.equal(unsafe.counters.filesParsed, 0);
    assert.equal(await normalizedGraphMatchesCleanRebuild(fixture.root), true);
  } finally {
    await rm(fixture.root, { recursive: true, force: true });
  }
});
