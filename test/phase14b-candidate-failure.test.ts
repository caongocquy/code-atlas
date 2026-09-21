import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

test("candidate failure leaves active generation unchanged", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14b-candidate-failure-"));
  const originalWriteCandidateGraph = AtlasStore.prototype.writeCandidateGraph;
  try {
    await writeFile(path.join(root, "source.ts"), "export function source() { return true; }\n");
    const first = await indexRepository(root, { skipGit: true });
    assert.equal(first.kind, "published");
    const repositoryId = getRepositoryIdentity(root).id;
    const before = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    const activeBefore = {
      generationId: before.getActiveGenerationId(repositoryId),
      graph: before.loadGraph(repositoryId),
    };
    before.close();

    AtlasStore.prototype.writeCandidateGraph = function failCandidateGraphWrite(): never {
      throw new Error("injected candidate graph failure");
    };
    const failed = await syncRepository(root, { skipGit: true });
    assert.equal(failed.kind, "failed");
    assert.equal(failed.published, false);
    assert.equal(failed.activeGenerationId, activeBefore.generationId);

    const after = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      assert.deepEqual({
        generationId: after.getActiveGenerationId(repositoryId),
        graph: after.loadGraph(repositoryId),
      }, activeBefore);
    } finally {
      after.close();
    }
  } finally {
    AtlasStore.prototype.writeCandidateGraph = originalWriteCandidateGraph;
    await rm(root, { recursive: true, force: true });
  }
});
