import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import type { FrameworkMaterialization } from "../src/core/framework/framework.types.js";
import { createCandidateGeneration } from "../src/core/indexing/index-manifest.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

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

test("versioned candidates require a complete framework snapshot before publication", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14c-publication-"));
  try {
    const store = new AtlasStore(path.join(root, "atlas.db"));
    const repository = store.ensureRepository(getRepositoryIdentity(path.join(root, "repo")));
    const generation = createCandidateGeneration(repository.id, undefined, CURRENT_INDEX_VERSION_DOMAINS, []);
    store.beginCandidateGeneration(generation);
    store.writeCandidateManifest(generation.manifest);

    assert.throws(
      () => store.publishCandidateGeneration(generation.id),
      /framework materialization is missing/i,
    );
    assert.equal(store.getActiveGenerationId(repository.id), undefined);

    store.writeCandidateFramework(generation.id, emptyFramework());
    store.publishCandidateGeneration(generation.id, { frameworkStaged: true });

    assert.equal(store.getActiveGenerationId(repository.id), generation.id);
    assert.equal(store.loadFramework(repository.id)?.frameworkResolutionVersion, CURRENT_INDEX_VERSION_DOMAINS.frameworkResolutionVersion);
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
