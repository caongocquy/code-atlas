import assert from "node:assert/strict";
import { mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import type { EmbeddingProvider } from "../src/core/semantic/embedding-provider.js";
import type { VectorPoint, VectorStore } from "../src/core/semantic/vector-store.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

function semanticFixtures(): { embeddingProvider: EmbeddingProvider & { calls: number; fail: boolean }; vectorStore: VectorStore; upsertCalls: number } {
  const points = new Map<string, VectorPoint>();
  const counters = { upsertCalls: 0 };
  const provider = {
    id: "task7-embedding",
    version: "1",
    dimensions: 2,
    calls: 0,
    fail: false,
    isAvailable: async () => true,
    embedBatch: async (texts: string[]) => {
      provider.calls += 1;
      if (provider.fail) throw new Error("temporary embedding failure");
      return texts.map(() => [1, 0]);
    },
  };
  return {
    embeddingProvider: provider,
    vectorStore: {
      id: "task7-vector",
      isAvailable: async () => true,
      ensureCollection: async () => undefined,
      search: async () => [],
      count: async () => points.size,
      getIndexedFileStates: async () => new Map(),
      upsert: async (values) => {
        counters.upsertCalls += 1;
        values.forEach((point) => points.set(String(point.id), point));
      },
      deletePointIds: async () => undefined,
      deleteFile: async () => undefined,
    },
    get upsertCalls() {
      return counters.upsertCalls;
    },
  };
}

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

test("enabled semantic indexing embeds shared facts and publishes active semantic rows", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-semantic-"));
  const fixtures = semanticFixtures();

  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");
    const result = await indexRepository(repoPath, {
      skipGit: true,
      includeSemantic: true,
      semanticProviders: fixtures,
    });
    assert.equal(result.kind, "published");
    assert.equal(fixtures.embeddingProvider.calls > 0, true);
    assert.equal(fixtures.upsertCalls > 0, true);

    const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    try {
      const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
      assert.equal(store.countSemanticVectors(repository.id) > 0, true);
      assert.equal(await fixtures.vectorStore.count(repository.id) > 0, true);
    } finally {
      store.close();
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("disabled semantic indexing does not invoke an available provider", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-semantic-disabled-"));
  const fixtures = semanticFixtures();

  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() {}\n");
    const result = await indexRepository(repoPath, {
      skipGit: true,
      semanticProviders: fixtures,
    });
    assert.equal(result.kind, "published");
    assert.equal(fixtures.embeddingProvider.calls, 0);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("unavailable semantic indexing remains non-mandatory", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-semantic-unavailable-"));
  const fixtures = semanticFixtures();
  fixtures.embeddingProvider.isAvailable = async () => false;

  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() {}\n");
    const result = await indexRepository(repoPath, {
      skipGit: true,
      includeSemantic: true,
      semanticProviders: fixtures,
    });
    assert.equal(result.kind, "published");
    assert.equal(fixtures.embeddingProvider.calls, 0);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("a temporary semantic preparation failure retains the active semantic generation", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-semantic-failure-"));
  const fixtures = semanticFixtures();

  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");
    const first = await indexRepository(repoPath, {
      skipGit: true,
      includeSemantic: true,
      semanticProviders: fixtures,
    });
    assert.equal(first.kind, "published");
    const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
    const activeBefore = store.getActiveGenerationId(repository.id);
    const semanticRowsBefore = store.countSemanticVectors(repository.id);
    store.close();

    fixtures.embeddingProvider.fail = true;
    const failed = await syncRepository(repoPath, {
      skipGit: true,
      includeSemantic: true,
      semanticProviders: fixtures,
    });
    assert.equal(failed.kind, "failed");
    assert.equal(failed.published, false);

    const after = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    try {
      assert.equal(after.getActiveGenerationId(repository.id), activeBefore);
      assert.equal(after.countSemanticVectors(repository.id), semanticRowsBefore);
    } finally {
      after.close();
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("disabled semantic sync preserves active semantic rows", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-semantic-preserved-"));
  const fixtures = semanticFixtures();

  try {
    await writeFile(path.join(repoPath, "kept.ts"), "export function kept() { return true; }\n");
    await writeFile(path.join(repoPath, "removed.ts"), "export function removed() { return false; }\n");
    const first = await indexRepository(repoPath, {
      skipGit: true,
      includeSemantic: true,
      semanticProviders: fixtures,
    });
    assert.equal(first.kind, "published");

    const before = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    const repository = before.ensureRepository(getRepositoryIdentity(repoPath));
    const activeBefore = before.getActiveGenerationId(repository.id);
    before.close();
    await unlink(path.join(repoPath, "removed.ts"));

    const result = await syncRepository(repoPath, { skipGit: true });
    assert.equal(result.kind, "published");

    const after = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    try {
      assert.notEqual(after.getActiveGenerationId(repository.id), activeBefore);
      const semanticFiles = after.getSemanticIndexedFileStates(repository.id);
      assert.equal(semanticFiles.has("kept.ts"), true);
      assert.equal(semanticFiles.has("removed.ts"), false);
    } finally {
      after.close();
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("a pre-publication candidate write failure retains the active generation", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-rollback-"));
  const original = AtlasStore.prototype.writeCandidateLexicalDocuments;

  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() {}\n");
    const first = await indexRepository(repoPath, { skipGit: true });
    assert.equal(first.kind, "published");
    const activeBefore = first.kind === "published" ? first.generationId : undefined;
    AtlasStore.prototype.writeCandidateLexicalDocuments = () => {
      throw new Error("injected candidate write failure");
    };
    const failed = await syncRepository(repoPath, { skipGit: true });
    assert.equal(failed.kind, "failed");
    assert.equal(failed.published, false);

    const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    try {
      const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
      assert.equal(store.getActiveGenerationId(repository.id), activeBefore);
    } finally {
      store.close();
    }
  } finally {
    AtlasStore.prototype.writeCandidateLexicalDocuments = original;
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("an empty repository publishes a valid zero-symbol generation", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-empty-"));

  try {
    const result = await indexRepository(repoPath, { skipGit: true });
    assert.equal(result.kind, "published");
    const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    try {
      const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
      assert.equal(store.getActiveGenerationId(repository.id), result.kind === "published" ? result.generationId : undefined);
      assert.deepEqual(store.loadGraph(repository.id), { nodes: [], edges: [] });
    } finally {
      store.close();
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
