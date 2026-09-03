import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { LEXICAL_INDEX_VERSION } from "../src/config/constants.js";
import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { repositoryRelativePath, scanRepo } from "../src/core/repository/repository-files.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

const execFileAsync = promisify(execFile);

async function git(repoPath: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd: repoPath, encoding: "utf8" });
}

async function gitRepository(name: string): Promise<string> {
  const repoPath = await mkdtemp(path.join(tmpdir(), `code-atlas-phase-4-${name}-`));
  await git(repoPath, ["init", "-q"]);
  await git(repoPath, ["config", "user.email", "code-atlas@example.test"]);
  await git(repoPath, ["config", "user.name", "CodeAtlas Tests"]);
  return repoPath;
}

function graphShape(graph: { nodes: Array<Record<string, unknown>>; edges: Array<Record<string, unknown>> }): string {
  const nodes = graph.nodes.map((node) => ({
    type: node.type,
    name: node.name,
    qualifiedName: node.qualifiedName,
    file: node.file,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const nodeLabels = new Map(
    graph.nodes.map((node) => [node.id, `${node.file}:${node.type}:${node.name}`]),
  );
  const edges = graph.edges.map((edge) => ({
    from: nodeLabels.get(edge.from),
    to: nodeLabels.get(edge.to),
    type: edge.type,
  })).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

  return JSON.stringify({ nodes, edges });
}

test("IndexPipeline indexes graph and lexical data, then keeps an unchanged sync current", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-4-pipeline-"));

  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");
    await writeFile(path.join(repoPath, "empty.ts"), "// no symbols\n");

    const indexed = await indexRepository(repoPath, { skipGit: true });
    assert.equal(indexed.operation, "index");
    assert.equal(indexed.changeDetection, "filesystem");
    assert.equal(indexed.graph.fullRebuild, true);
    assert.equal(indexed.lexical.status, "indexed");

    const current = await syncRepository(repoPath, { skipGit: true });
    assert.equal(current.changeDetection, "filesystem");
    assert.equal(current.graph.status, "current");
    assert.equal(current.lexical.status, "current");
    assert.deepEqual(current.changes.candidateFiles, []);

    const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    try {
      const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
      assert.equal(store.getFileCapabilityState(repository.id, "empty.ts", "lexical")?.state, "ready");
      assert.equal(store.getFileCapabilityState(repository.id, "empty.ts", "lexical")?.itemCount, 0);
    } finally {
      store.close();
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("Git sync and forced filesystem sync converge after modified, untracked, deleted, and renamed files", async () => {
  const gitPath = await gitRepository("git");
  const filesystemPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-4-filesystem-"));

  try {
    const initialFiles = {
      "src/target.ts": "export function oldTarget() { return true; }\n",
      "src/importer.ts": "import { oldTarget } from './target.js'; export function run() { return oldTarget(); }\n",
    };

    for (const [relativePath, content] of Object.entries(initialFiles)) {
      for (const directory of [gitPath, filesystemPath]) {
        await mkdir(path.dirname(path.join(directory, relativePath)), { recursive: true });
        await writeFile(path.join(directory, relativePath), content);
      }
    }

    await git(gitPath, ["add", "."]);
    await git(gitPath, ["commit", "-qm", "initial"]);
    await indexRepository(gitPath, { skipGit: true });
    await indexRepository(filesystemPath, { skipGit: true });

    await writeFile(path.join(gitPath, "src/target.ts"), "export function newTarget() { return true; }\n");
    await writeFile(path.join(gitPath, "src/added.ts"), "export function addedTarget() { return true; }\n");
    await writeFile(path.join(gitPath, "src/untracked.ts"), "export function untrackedTarget() { return true; }\n");
    await rm(path.join(gitPath, "src/importer.ts"));
    await git(gitPath, ["mv", "src/target.ts", "src/renamed.ts"]);
    await git(gitPath, ["add", "src/added.ts"]);

    await writeFile(path.join(filesystemPath, "src/renamed.ts"), "export function newTarget() { return true; }\n");
    await writeFile(path.join(filesystemPath, "src/added.ts"), "export function addedTarget() { return true; }\n");
    await writeFile(path.join(filesystemPath, "src/untracked.ts"), "export function untrackedTarget() { return true; }\n");
    await rm(path.join(filesystemPath, "src/target.ts"));
    await rm(path.join(filesystemPath, "src/importer.ts"));

    const gitResult = await syncRepository(gitPath);
    const filesystemResult = await syncRepository(filesystemPath, { skipGit: true });
    assert.equal(gitResult.changeDetection, "git");
    assert.equal(filesystemResult.changeDetection, "filesystem");
    assert.ok(gitResult.changes.deletedFiles.includes("src/target.ts"));
    assert.ok(gitResult.changes.candidateFiles.includes("src/added.ts"));
    assert.ok(gitResult.changes.candidateFiles.includes("src/untracked.ts"));

    const gitStore = new AtlasStore(path.join(gitPath, ".codeatlas", "atlas.db"));
    const filesystemStore = new AtlasStore(path.join(filesystemPath, ".codeatlas", "atlas.db"));
    try {
      const gitId = gitStore.ensureRepository(getRepositoryIdentity(gitPath)).id;
      const filesystemId = filesystemStore.ensureRepository(getRepositoryIdentity(filesystemPath)).id;
      assert.equal(graphShape(gitStore.loadGraph(gitId)), graphShape(filesystemStore.loadGraph(filesystemId)));
    } finally {
      gitStore.close();
      filesystemStore.close();
    }
  } finally {
    await rm(gitPath, { recursive: true, force: true });
    await rm(filesystemPath, { recursive: true, force: true });
  }
});

test("non-Git repositories fall back to filesystem and ignore runtime, generated, dependency, and symlink paths", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-4-scan-"));
  const outsidePath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-4-outside-"));

  try {
    await writeFile(path.join(repoPath, "main.ts"), "export function main() {}\n");
    for (const directory of [".codeatlas", ".code-rag", "node_modules", "dist", "build"]) {
      await mkdir(path.join(repoPath, directory), { recursive: true });
      await writeFile(path.join(repoPath, directory, "hidden.ts"), "export function hidden() {}\n");
    }
    await writeFile(path.join(outsidePath, "outside.ts"), "export function outside() {}\n");
    await symlink(path.join(outsidePath, "outside.ts"), path.join(repoPath, "linked.ts"));

    const files = await scanRepo(repoPath);
    assert.deepEqual(files.map((file) => repositoryRelativePath(repoPath, file)), ["main.ts"]);
    const result = await syncRepository(repoPath);
    assert.equal(result.changeDetection, "filesystem");
    assert.equal(result.semantic, undefined);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
    await rm(outsidePath, { recursive: true, force: true });
  }
});

test("lexical version mismatch is isolated from graph state and semantic infrastructure", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-4-version-"));

  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");
    await indexRepository(repoPath, { skipGit: true });

    const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
    const graphBefore = graphShape(store.loadGraph(repository.id));
    store.setVersion(repository.id, "lexical", "old-lexical");
    store.close();

    const result = await syncRepository(repoPath, { skipGit: true });
    assert.equal(result.lexical.fullRebuild, true);
    assert.equal(result.graph.status, "current");
    assert.equal(result.semantic, undefined);

    const reopened = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    try {
      const identity = reopened.ensureRepository(getRepositoryIdentity(repoPath));
      assert.equal(reopened.getVersion(identity.id, "lexical"), LEXICAL_INDEX_VERSION);
      assert.equal(graphShape(reopened.loadGraph(identity.id)), graphBefore);
    } finally {
      reopened.close();
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
