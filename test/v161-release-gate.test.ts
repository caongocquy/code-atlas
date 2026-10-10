import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { scanModuleConfigFiles } from "../src/core/indexing/filesystem-change-detector.js";
import { createCandidateGeneration } from "../src/core/indexing/index-manifest.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

const versions = {
  schemaVersion: "2",
  factsSchemaVersion: "1",
  factsVersion: "1",
  resolutionVersion: "1",
  derivedVersion: "1",
};

test("config scan skips git-ignored files and nested repositories", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-atlas-config-scan-"));
  try {
    await mkdir(path.join(root, "ignored"), { recursive: true });
    await mkdir(path.join(root, "nested", ".git"), { recursive: true });
    await writeFile(path.join(root, ".gitignore"), "ignored/\n");
    await writeFile(path.join(root, "package.json"), "{}");
    await writeFile(path.join(root, "ignored", "package.json"), "{}");
    await writeFile(path.join(root, "nested", "package.json"), "{}");
    assert.deepEqual(await scanModuleConfigFiles(root), [".gitignore", "package.json"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("concurrent candidates publish only while their recorded parent is active", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-atlas-publication-cas-"));
  const store = new AtlasStore(path.join(root, "atlas.db"));
  let competingStore: AtlasStore | undefined;
  try {
    const repository = store.ensureRepository(getRepositoryIdentity(root));
    const first = createCandidateGeneration(repository.id, undefined, versions, []);
    store.beginCandidateGeneration(first);
    store.writeCandidateManifest(first.manifest);
    store.publishCandidateGeneration(first.id);

    const stale = createCandidateGeneration(repository.id, first.id, versions, []);
    const current = createCandidateGeneration(repository.id, first.id, versions, []);
    store.beginCandidateGeneration(stale);
    store.writeCandidateManifest(stale.manifest);
    store.beginCandidateGeneration(current);
    store.writeCandidateManifest(current.manifest);
    competingStore = new AtlasStore(path.join(root, "atlas.db"));

    const results = await Promise.allSettled([
      Promise.resolve().then(() => store.publishCandidateGeneration(current.id)),
      Promise.resolve().then(() => competingStore!.publishCandidateGeneration(stale.id)),
    ]);
    assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(results[1]?.status, "rejected");
    assert.match(String(results[1]?.status === "rejected" && results[1].reason), /parent generation/i);
    assert.equal(store.getActiveGenerationId(repository.id), current.id);
  } finally {
    competingStore?.close();
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
