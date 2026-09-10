import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { createCandidateGeneration } from "../src/core/indexing/index-manifest.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import type { FrameworkMaterialization } from "../src/core/framework/framework.types.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

const execFileAsync = promisify(execFile);

function emptyFramework(): FrameworkMaterialization {
  return {
    frameworkResolutionVersion: CURRENT_INDEX_VERSION_DOMAINS.frameworkResolutionVersion!,
    entities: [],
    relationships: [],
    classifications: [],
    diagnostics: [],
    coverage: [],
    config: [],
    detections: [],
    dependencies: [],
    complete: true,
  };
}

async function git(repoPath: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repoPath });
}

async function initializeGitRepository(repoPath: string): Promise<void> {
  await git(repoPath, ["init", "-q"]);
  await git(repoPath, ["config", "user.email", "test@example.com"]);
  await git(repoPath, ["config", "user.name", "CodeAtlas Test"]);
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "-qm", "initial"]);
}

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

test("ordinary package imports remain bounded in the production pipeline", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14b-package-import-"));
  try {
    await writeFile(path.join(root, "consumer.ts"), 'import path from "node:path"; export const value = path.sep;\n');
    await indexRepository(root, { skipGit: true });
    const result = await syncRepository(root, { skipGit: true });
    assert.equal(result.kind, "published");
    assert.equal(result.plan.fullGraphResolution, false);
    assert.equal(result.counters.filesParsed, 0);
    assert.equal(result.counters.filesResolved, 0);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed module configuration file forces repository resolution", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14b-module-config-"));
  try {
    await writeFile(path.join(root, "tsconfig.json"), '{"compilerOptions":{"module":"commonjs"}}\n');
    await writeFile(path.join(root, "source.ts"), "export function source() { return 1; }\n");
    await initializeGitRepository(root);
    await indexRepository(root);
    await writeFile(path.join(root, "tsconfig.json"), '{"compilerOptions":{"module":"esnext"}}\n');
    const result = await syncRepository(root);
    assert.equal(result.kind, "published");
    assert.equal(result.plan.fullGraphResolution, true);
    assert.ok(result.plan.reasons.includes("module_config_changed"));
    assert.equal(result.counters.filesParsed, 0);
    assert.equal(result.counters.filesResolved, 1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem mode detects changed module configuration files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14b-filesystem-config-"));
  try {
    await writeFile(path.join(root, "source.ts"), "export function source() { return 1; }\n");
    for (const file of ["package.json", "tsconfig.json", "jsconfig.json"]) {
      await writeFile(path.join(root, file), "{}\n");
    }
    await indexRepository(root, { skipGit: true });

    for (const file of ["package.json", "tsconfig.json", "jsconfig.json"]) {
      await writeFile(path.join(root, file), `{"changed":"${file}"}\n`);
      const result = await syncRepository(root, { skipGit: true });
      assert.equal(result.kind, "published");
      assert.equal(result.plan.fullGraphResolution, true, file);
      assert.ok(result.plan.reasons.includes("module_config_changed"), file);
      assert.equal(result.counters.filesParsed, 0, file);
      assert.equal(result.counters.filesResolved, 1, file);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("filesystem mode detects nested module configuration files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14b-nested-filesystem-config-"));
  const workspace = path.join(root, "workspace", "packages", "app");
  try {
    await mkdir(workspace, { recursive: true });
    await writeFile(path.join(root, "source.ts"), "export function source() { return 1; }\n");
    for (const file of ["package.json", "tsconfig.json", "jsconfig.json"]) {
      await writeFile(path.join(workspace, file), "{}\n");
    }
    await indexRepository(root, { skipGit: true });

    for (const file of ["package.json", "tsconfig.json", "jsconfig.json"]) {
      await writeFile(path.join(workspace, file), `{"changed":"${file}"}\n`);
      const result = await syncRepository(root, { skipGit: true });
      assert.equal(result.kind, "published");
      assert.equal(result.plan.fullGraphResolution, true, file);
      assert.ok(result.plan.reasons.includes("module_config_changed"), file);
      assert.equal(result.counters.filesParsed, 0, file);
      assert.equal(result.counters.filesResolved, 1, file);
    }

    await rm(path.join(workspace, "jsconfig.json"));
    const removed = await syncRepository(root, { skipGit: true });
    assert.equal(removed.kind, "published");
    assert.equal(removed.plan.fullGraphResolution, true);
    assert.ok(removed.plan.reasons.includes("module_config_changed"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ambiguous star exports force repository resolution from current facts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14b-export-ambiguity-"));
  try {
    await writeFile(path.join(root, "a.ts"), "export function duplicate() { return 1; }\n");
    await writeFile(path.join(root, "b.ts"), "export function duplicate() { return 2; }\n");
    await writeFile(path.join(root, "barrel.ts"), 'export * from "./a.js";\nexport * from "./b.js";\n');
    await writeFile(path.join(root, "consumer.ts"), 'import { duplicate } from "./barrel.js"; export function value() { return duplicate(); }\n');
    await indexRepository(root, { skipGit: true });
    const result = await syncRepository(root, { skipGit: true });
    assert.equal(result.kind, "published");
    assert.equal(result.plan.fullGraphResolution, true);
    assert.ok(result.plan.reasons.includes("export_ambiguous"));
    assert.equal(result.counters.filesParsed, 0);
    assert.equal(result.counters.filesResolved, 4);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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

test("incomplete semantic provenance forces repository resolution on unchanged sync", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14b-legacy-edge-"));
  const dependency = path.join(root, "src", "dep.ts");

  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "consumer.ts"), 'import { dep } from "./dep.js"; export const consumer = dep;\n');
    await writeFile(dependency, "export function dep() { return true; }\n");
    await writeFile(path.join(root, "src", "unrelated.c"), "int stable() { return 1; }\nint use() { return stable(); }\n");

    const first = await indexRepository(root, { skipGit: true });
    assert.equal(first.kind, "published");
    const repositoryId = getRepositoryIdentity(root).id;
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    const activeGenerationId = store.getActiveGenerationId(repositoryId);
    const activeManifest = store.getGenerationManifest(repositoryId);
    assert.ok(activeGenerationId);
    assert.ok(activeManifest);
    const candidate = createCandidateGeneration(repositoryId, activeGenerationId, activeManifest.versions, activeManifest.files);
    store.beginCandidateGeneration(candidate);
    store.writeCandidateManifest(candidate.manifest);
    const graph = store.loadGraph(repositoryId);
    const legacyEdge = graph.edges.find((edge) => edge.type === "calls" && graph.nodes.find((node) => node.id === edge.from)?.file === "src/unrelated.c");
    assert.ok(legacyEdge);
    store.writeCandidateGraph(candidate.id, {
      nodes: graph.nodes,
      edges: graph.edges.map((edge) => {
        if (edge !== legacyEdge) return edge;
        const { resolution: _resolution, ...withoutResolution } = edge;
        return withoutResolution;
      }),
    }, new Map());
    store.copyActiveGraphResolutionToCandidate(candidate.id);
    store.writeCandidateFramework(candidate.id, emptyFramework());
    store.publishCandidateGeneration(candidate.id, { frameworkStaged: true });
    store.close();

    const unchanged = await syncRepository(root, { skipGit: true });
    assert.equal(unchanged.kind, "published");
    assert.equal(unchanged.plan.fullGraphResolution, true);
    assert.equal(unchanged.counters.filesParsed, 0);
    assert.equal(unchanged.counters.filesResolved, 3);
    const afterUnchanged = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    const afterUnchangedGraph = afterUnchanged.loadGraph(repositoryId);
    assert.ok(afterUnchangedGraph.edges.some((edge) =>
      edge.type === "calls"
      && edge.resolution?.resolutionVersion === CURRENT_INDEX_VERSION_DOMAINS.resolutionVersion
      && afterUnchangedGraph.nodes.find((node) => node.id === edge.from)?.file === "src/unrelated.c",
    ));
    afterUnchanged.close();

    await writeFile(dependency, "export function dep() { return false; }\n");
    const result = await syncRepository(root, { skipGit: true });
    assert.equal(result.kind, "published");
    const after = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    assert.ok(semanticEdgeKeys(after, repositoryId).some((edge) => edge.includes("src/unrelated.c")));
    after.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
