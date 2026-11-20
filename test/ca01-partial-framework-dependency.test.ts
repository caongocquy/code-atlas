import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

test("CA-01 partial non-JSX TypeScript facts do not invalidate unrelated React evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-ca01-partial-react-"));
  try {
    await writeFile(path.join(root, "broken.ts"), "export function broken( {\n");
    await writeFile(path.join(root, "App.tsx"), "export function App() { return <div />; }\n");

    const result = await indexRepository(root, { skipGit: true });
    assert.equal(result.kind, "published");

    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      const repository = store.ensureRepository(getRepositoryIdentity(root));
      const manifest = store.getGenerationManifest(repository.id);
      assert.ok(manifest?.files.some((file) => file.relativePath === "broken.ts"));
      const framework = store.loadFramework(repository.id);
      assert.ok(framework?.dependencies.some((entry) => entry.ownerPath === "App.tsx"));
      assert.equal(framework?.dependencies.some((entry) => entry.ownerPath === "broken.ts"), false);
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
