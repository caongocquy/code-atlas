import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

test("index publishes one typed generation and unchanged sync reuses it", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-indexing-"));

  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");

    const first = await indexRepository(repoPath, { skipGit: true });
    assert.equal(first.kind, "published");
    assert.equal(first.published, true);
    assert.equal(first.plan.parsePaths.length, 1);

    const second = await syncRepository(repoPath, { skipGit: true });
    assert.equal(second.kind, "published");
    assert.equal(second.published, true);
    assert.deepEqual(second.plan.parsePaths, []);
    assert.deepEqual(second.plan.reusePaths, ["source.ts"]);

    const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    try {
      const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
      assert.equal(store.getActiveGenerationId(repository.id), second.generationId);
      assert.notEqual(first.generationId, second.generationId);
    } finally {
      store.close();
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("sync removes deleted files from the published candidate", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-delete-"));

  try {
    await writeFile(path.join(repoPath, "kept.ts"), "export function kept() {}\n");
    await writeFile(path.join(repoPath, "removed.ts"), "export function removed() {}\n");
    await indexRepository(repoPath, { skipGit: true });
    await rm(path.join(repoPath, "removed.ts"));

    const result = await syncRepository(repoPath, { skipGit: true });
    assert.equal(result.kind, "published");
    assert.deepEqual(result.plan.removedPaths, ["removed.ts"]);

    const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    try {
      const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
      assert.equal(store.loadGraph(repository.id).nodes.some((node) => node.file === "removed.ts"), false);
      assert.equal(store.getGenerationManifest(repository.id)?.files.some((file) => file.relativePath === "removed.ts"), false);
    } finally {
      store.close();
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
