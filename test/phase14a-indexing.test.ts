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
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import { getRepositoryStatusReadOnly } from "../src/core/repository/repository-status.service.js";

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
    assert.deepEqual(first.counters, {
      filesScanned: 1,
      filesHashed: 1,
      factCacheHits: 0,
      factCacheMisses: 1,
      filesParsed: 1,
      filesResolved: 1,
      importersInvalidated: 0,
      fullResolutionFallbacks: 0,
      frameworkFilesResolved: 1,
      frameworkFilesReused: 0,
    });
    assert.deepEqual(second.counters, {
      filesScanned: 1,
      filesHashed: 1,
      factCacheHits: 1,
      factCacheMisses: 0,
      filesParsed: 0,
      filesResolved: 0,
      importersInvalidated: 0,
      fullResolutionFallbacks: 0,
      frameworkFilesResolved: 0,
      frameworkFilesReused: 1,
    });
    assert.doesNotMatch(JSON.stringify(first), /filesParsed|factCacheMisses/);

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

test("index work counters observe importer invalidation and uncertain resolution fallback", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-counter-evidence-"));
  try {
    await writeFile(path.join(repoPath, "dependency.ts"), "export const dependency = true;\n");
    await writeFile(path.join(repoPath, "consumer.ts"), 'import { dependency } from "./dependency.js"; export const consumer = dependency;\n');
    await writeFile(path.join(repoPath, "external.ts"), 'import path from "node:path"; export const external = path;\n');
    await indexRepository(repoPath, { skipGit: true });

    await writeFile(path.join(repoPath, "dependency.ts"), "export const dependency = false;\n");
    const result = await syncRepository(repoPath, { skipGit: true });
    assert.equal(result.kind, "published");
    assert.equal(result.counters.importersInvalidated, 1);
    assert.equal(result.counters.fullResolutionFallbacks, 1);
    assert.equal(result.counters.filesResolved, 3);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("version domains drive parsing and resolution counters independently", async () => {
  const run = async (domain: "resolutionVersion" | "factsVersion" | "derivedVersion") => {
    const repoPath = await mkdtemp(path.join(tmpdir(), `code-atlas-phase14a-version-${domain}-`));
    try {
      await writeFile(path.join(repoPath, "one.ts"), "export const one = 1;\n");
      await writeFile(path.join(repoPath, "two.ts"), "export const two = 2;\n");
      await indexRepository(repoPath, { skipGit: true });
      const previous = CURRENT_INDEX_VERSION_DOMAINS[domain];
      CURRENT_INDEX_VERSION_DOMAINS[domain] = `${previous}-bump`;
      try {
        return await syncRepository(repoPath, { skipGit: true });
      } finally {
        CURRENT_INDEX_VERSION_DOMAINS[domain] = previous;
      }
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  };

  const resolution = await run("resolutionVersion");
  assert.equal(resolution.kind, "published");
  assert.equal(resolution.counters.filesParsed, 0);
  assert.equal(resolution.counters.filesResolved, 2);

  const facts = await run("factsVersion");
  assert.equal(facts.kind, "published");
  assert.equal(facts.counters.filesParsed, 2);

  const derived = await run("derivedVersion");
  assert.equal(derived.kind, "published");
  assert.equal(derived.counters.filesParsed, 0);
  assert.equal(derived.counters.filesResolved, 0);
});

test("index work counters are deterministic for a cold, unchanged, modified, and renamed fixture", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-counters-"));

  try {
    await Promise.all(Array.from({ length: 100 }, (_, index) =>
      writeFile(path.join(repoPath, `file-${String(index).padStart(3, "0")}.ts`), `export const value${index} = ${index};\n`)));

    const cold = await indexRepository(repoPath, { skipGit: true });
    assert.equal(cold.kind, "published");
    assert.equal(cold.counters.filesParsed, 100);
    assert.equal(cold.counters.factCacheMisses, 100);
    assert.equal(cold.counters.filesScanned, 100);
    assert.equal(cold.counters.filesHashed, 100);

    const unchanged = await syncRepository(repoPath, { skipGit: true });
    assert.equal(unchanged.kind, "published");
    assert.equal(unchanged.counters.filesParsed, 0);
    assert.equal(unchanged.counters.factCacheHits, 100);

    await writeFile(path.join(repoPath, "file-042.ts"), "export const value42 = 4200;\n");
    const modified = await syncRepository(repoPath, { skipGit: true });
    assert.equal(modified.kind, "published");
    assert.equal(modified.counters.filesParsed, 1);
    assert.equal(modified.counters.factCacheMisses, 1);

    await rm(path.join(repoPath, "file-042.ts"));
    await writeFile(path.join(repoPath, "renamed.ts"), "export const value42 = 4200;\n");
    const renamed = await syncRepository(repoPath, { skipGit: true });
    assert.equal(renamed.kind, "published");
    assert.equal(renamed.counters.filesParsed, 0);
    assert.equal(renamed.counters.factCacheHits, 100);
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
    assert.equal(result.semantic?.files, 1);
    assert.equal(result.semantic?.points > 0, true);

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

test("v2 publication preserves graph resolution coverage and diagnostics for status readers", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-resolution-state-"));

  try {
    await writeFile(path.join(repoPath, "dynamic.ts"), "export function dynamic(obj: unknown, method: string) { return obj[method](); }\n");
    const result = await indexRepository(repoPath, { skipGit: true });
    assert.equal(result.kind, "published");

    const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    try {
      const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
      const coverage = store.getGraphResolutionCoverage(repository.id);
      const diagnostics = store.getGraphResolutionDiagnostics(repository.id);
      assert.equal(coverage.mayBeIncomplete, true);
      assert.equal(coverage.unsupportedDynamic > 0, true);
      assert.equal(diagnostics.some((item) => item.kind === "unresolved" && item.unsupportedDynamic === true && item.evidence.length > 0), true);

      const status = await getRepositoryStatusReadOnly(repoPath);
      assert.deepEqual(status.graph.resolutionCoverage, coverage);
      const second = await syncRepository(repoPath, { skipGit: true });
      assert.equal(second.kind, "published");
      const afterSync = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
      try {
        assert.deepEqual(afterSync.getGraphResolutionCoverage(repository.id), coverage);
        assert.deepEqual(afterSync.getGraphResolutionDiagnostics(repository.id), diagnostics);
      } finally {
        afterSync.close();
      }
    } finally {
      store.close();
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("supported empty source files publish as complete zero-fact units", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-empty-file-"));

  try {
    await writeFile(path.join(repoPath, "empty.ts"), "");
    await writeFile(path.join(repoPath, "empty.js"), "");
    await writeFile(path.join(repoPath, "notes.txt"), "");
    const result = await indexRepository(repoPath, { skipGit: true });
    assert.equal(result.kind, "published");

    const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    try {
      const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
      const manifest = store.getGenerationManifest(repository.id);
      assert.deepEqual(manifest?.files.map((file) => file.relativePath), ["empty.js", "empty.ts"]);
      const graph = store.loadGraph(repository.id);
      assert.equal(graph.nodes.filter((node) => node.type === "file").length, 2);
      assert.equal(graph.nodes.some((node) => node.type !== "file"), false);
      assert.equal(store.getFileStates(repository.id).size, 2);
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

test("a semantic preparation failure publishes graph and lexical updates and marks semantic state as error", async () => {
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

    await writeFile(path.join(repoPath, "source.ts"), "export function source() { return false; }\n");
    fixtures.embeddingProvider.fail = true;
    const failed = await syncRepository(repoPath, {
      skipGit: true,
      includeSemantic: true,
      semanticProviders: fixtures,
    });
    assert.equal(failed.kind, "published");
    assert.notEqual(failed.generationId, activeBefore);

    const after = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    try {
      assert.equal(after.getActiveGenerationId(repository.id), failed.generationId);
      assert.equal(after.countSemanticVectors(repository.id), semanticRowsBefore);
      const manifest = after.getGenerationManifest(repository.id);
      assert.equal(manifest?.files.some((file) => file.relativePath === "source.ts"), true);
      const semanticState = after.getFileCapabilityStates(repository.id, "semantic").get("source.ts");
      assert.equal(semanticState?.state, "error");
      assert.match(semanticState?.lastError ?? "", /embedding/i);
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
