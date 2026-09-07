import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";

import { buildCodeGraph, buildCodeGraphWithResolutionFromFacts } from "../src/core/graph/build-graph.js";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import type { IndexedSourceUnit } from "../src/core/indexing/indexing.types.js";

test("facts graph preserves clean-fixture graph nodes and edges", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-equivalence-"));
  const source = "export function helper() {}\nexport function run() { helper(); }\n";
  await writeFile(path.join(repoPath, "run.ts"), source);
  try {
    const extracted = extractParsedFacts({
    source,
    language: "typescript",
    contentHash: "equivalence",
    factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion,
    factsSchemaVersion: "1.0.0",
    });
    assert.equal(extracted.kind, "facts");
    if (extracted.kind !== "facts") throw extracted.error;

    const expected = await buildCodeGraph(repoPath, undefined, "repo");
    const actual = await buildCodeGraphWithResolutionFromFacts(repoPath, [{
    relativePath: "run.ts",
    source,
    facts: extracted.facts,
    } satisfies IndexedSourceUnit], undefined, "repo");

    assert.deepEqual(
    actual.graph.nodes.map(({ id, ...node }) => node),
    expected.nodes.map(({ id, ...node }) => node),
    );
    assert.deepEqual(
    actual.graph.edges.map(({ from, to, ...edge }) => ({ ...edge, from: from.replace(/^.*?:/, ""), to: to.replace(/^.*?:/, "") })),
    expected.edges.map(({ from, to, ...edge }) => ({ ...edge, from: from.replace(/^.*?:/, ""), to: to.replace(/^.*?:/, "") })),
    );
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("facts import edges deduplicate bindings from the same module", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-import-dedupe-"));
  const dependency = "export const first = 1; export const second = 2;\n";
  const source = 'import { first, second } from "./dep.js"; export const run = first + second;\n';
  await writeFile(path.join(repoPath, "dep.ts"), dependency);
  await writeFile(path.join(repoPath, "run.ts"), source);

  try {
    const units = ["dep.ts", "run.ts"].map((relativePath) => {
      const content = relativePath === "dep.ts" ? dependency : source;
      const extracted = extractParsedFacts({
        source: content,
        language: "typescript",
        contentHash: relativePath,
        factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion,
        factsSchemaVersion: "1.0.0",
      });
      assert.equal(extracted.kind, "facts");
      if (extracted.kind !== "facts") throw extracted.error;
      return { relativePath, source: content, facts: extracted.facts } satisfies IndexedSourceUnit;
    });
    const actual = await buildCodeGraphWithResolutionFromFacts(repoPath, units, undefined, "repo");
    const importEdges = actual.graph.edges.filter((edge) => edge.type === "imports");

    assert.equal(importEdges.length, 1);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

function normalizedGraph(graph: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> }) {
  const nodes = graph.nodes.map(({ id: _id, ...node }) => node).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const byId = new Map(graph.nodes.map((node) => [node.id, `${node.type}:${node.file}:${node.qualifiedName ?? node.name}`]));
  const edges = graph.edges.map(({ from, to, ...edge }) => ({
    ...edge,
    from: byId.get(from) ?? from,
    to: byId.get(to) ?? to,
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  return { nodes, edges };
}

test("incremental graph matches a clean full rebuild for imports, calls, extends, malformed, delete, and rename", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-equivalence-lifecycle-"));
  try {
    await writeFile(path.join(repoPath, "base.ts"), "export class Base { work() {} }\n");
    await writeFile(path.join(repoPath, "consumer.ts"), 'import { Base } from "./base.js"; export class Consumer extends Base { run() { this.work(); } }\n');
    await writeFile(path.join(repoPath, "broken.ts"), "export function broken( {\n");
    await writeFile(path.join(repoPath, "removed.ts"), "export const removed = true;\n");

    await indexRepository(repoPath, { skipGit: true });
    await rm(path.join(repoPath, "removed.ts"));
    await rm(path.join(repoPath, "base.ts"));
    await writeFile(path.join(repoPath, "renamed-base.ts"), "export class Base { work() {} }\n");
    await writeFile(path.join(repoPath, "consumer.ts"), 'import { Base } from "./renamed-base.js"; export class Consumer extends Base { run() { this.work(); } }\n');
    const incremental = await syncRepository(repoPath, { skipGit: true });
    assert.equal(incremental.kind, "published");

    const incrementalStore = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    const repository = incrementalStore.ensureRepository(getRepositoryIdentity(repoPath));
    const incrementalGraph = incrementalStore.loadGraph(repository.id);
    incrementalStore.close();

    await indexRepository(repoPath, { skipGit: true });
    const fullStore = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    try {
      const fullRepository = fullStore.ensureRepository(getRepositoryIdentity(repoPath));
      assert.deepEqual(normalizedGraph(incrementalGraph), normalizedGraph(fullStore.loadGraph(fullRepository.id)));
    } finally {
      fullStore.close();
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
