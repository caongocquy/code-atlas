import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

function semanticEdgeKeys(store: AtlasStore, repositoryId: string): string[] {
  const graph = store.loadGraph(repositoryId);
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.edges
    .filter((edge) => edge.type === "calls" || edge.type === "extends")
    .map((edge) => `${nodes.get(edge.from)?.file}:${nodes.get(edge.from)?.name}->${nodes.get(edge.to)?.file}:${nodes.get(edge.to)?.name}:${edge.type}`)
    .sort();
}

function graphNodeFiles(store: AtlasStore, repositoryId: string): string[] {
  return [...new Set(store.loadGraph(repositoryId).nodes.map((node) => node.file))].sort();
}

test("pipeline resolves only changed file and direct importer while retaining unrelated graph state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14b-pipeline-scope-"));
  const dependency = path.join(root, "src", "dep.ts");

  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "consumer.ts"), 'import { dep } from "./dep.js"; export const consumer = dep;\n');
    await writeFile(dependency, "export function dep() { return true; }\n");
    await writeFile(path.join(root, "src", "dynamic.ts"), "export function dynamic(obj: unknown, method: string) { return obj[method](); }\n");
    await writeFile(path.join(root, "src", "unrelated.c"), "int stable() { return 1; }\nint use() { return stable(); }\n");

    const first = await indexRepository(root, { skipGit: true });
    assert.equal(first.kind, "published");
    const repositoryId = getRepositoryIdentity(root).id;
    const before = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    const beforeSemanticEdges = semanticEdgeKeys(before, repositoryId);
    const beforeNodeFiles = graphNodeFiles(before, repositoryId);
    const beforeGraph = before.loadGraph(repositoryId);
    const beforeCoverage = before.getGraphResolutionCoverage(repositoryId);
    const beforeDiagnostics = before.getGraphResolutionDiagnostics(repositoryId);
    assert.ok(beforeSemanticEdges.some((edge) => edge.includes("src/unrelated.c") && edge.endsWith(":calls")));
    assert.ok(beforeGraph.edges.some((edge) => edge.type === "calls" && edge.resolution?.resolutionVersion === CURRENT_INDEX_VERSION_DOMAINS.resolutionVersion));
    before.close();

    await writeFile(dependency, "export function dep() { return false; }\n");
    const result = await syncRepository(root, { skipGit: true });

    assert.equal(result.kind, "published");
    assert.deepEqual(result.plan.resolvePaths, ["src/consumer.ts", "src/dep.ts"]);
    assert.deepEqual(result.plan.reusePaths, ["src/consumer.ts", "src/dynamic.ts", "src/unrelated.c"]);
    assert.equal(result.counters.filesParsed, 1);
    assert.equal(result.counters.filesResolved, 2);

    const after = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    assert.deepEqual(graphNodeFiles(after, repositoryId), beforeNodeFiles);
    const afterSemanticEdges = semanticEdgeKeys(after, repositoryId);
    assert.deepEqual(afterSemanticEdges.filter((edge) => edge.includes("src/unrelated.c")), beforeSemanticEdges.filter((edge) => edge.includes("src/unrelated.c")));
    assert.deepEqual(after.getGraphResolutionCoverage(repositoryId), beforeCoverage);
    assert.deepEqual(after.getGraphResolutionDiagnostics(repositoryId), beforeDiagnostics);
    after.close();

    const repeat = await syncRepository(root, { skipGit: true });
    assert.equal(repeat.kind, "published");
    assert.equal(repeat.counters.filesParsed, 0);
    assert.equal(repeat.counters.filesResolved, 0);
    const repeated = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    assert.deepEqual(semanticEdgeKeys(repeated, repositoryId), afterSemanticEdges);
    repeated.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
