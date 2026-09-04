import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { GRAPH_INDEX_VERSION, VECTOR_INDEX_VERSION } from "../src/config/constants.js";
import { inspectRetrieval } from "../src/core/retrieval/retrieval-inspector.service.js";
import { indexLexical } from "../src/core/lexical/lexical-index.service.js";
import { syncSemantic } from "../src/core/semantic/semantic-index.service.js";
import type { EmbeddingProvider } from "../src/core/semantic/embedding-provider.js";
import type { VectorPoint, VectorStore } from "../src/core/semantic/vector-store.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { createFileHash } from "../src/core/repository/file-hash.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

async function temporaryRepository(name: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `code-atlas-phase-5-${name}-`));
}

function embeddingProvider(version = "1"): EmbeddingProvider {
  return {
    id: "test-embedding",
    version,
    dimensions: 2,
    isAvailable: async () => true,
    embedBatch: async (texts) => texts.map((_, index) => [index + 1, 1]),
  };
}

function vectorStore(): VectorStore & { points: Map<string, VectorPoint>; deleted: string[] } {
  const points = new Map<string, VectorPoint>();
  const deleted: string[] = [];

  return {
    id: "test-vector",
    points,
    deleted,
    isAvailable: async () => true,
    ensureCollection: async () => undefined,
    search: async (repositoryId, _vector, limit) => Array.from(points.values())
      .filter((point) => !repositoryId || point.payload.repoId === repositoryId)
      .slice(0, limit)
      .map((point, index) => ({ score: 1 - index / 100, payload: point.payload })),
    count: async (repositoryId) => Array.from(points.values())
      .filter((point) => point.payload.repoId === repositoryId).length,
    getIndexedFileStates: async (repositoryId) => {
      const states = new Map<string, { fileHash: string; pointIds: Array<string | number> }>();

      for (const point of points.values()) {
        if (point.payload.repoId !== repositoryId) continue;
        const file = typeof point.payload.file === "string" ? point.payload.file : undefined;
        const fileHash = typeof point.payload.fileHash === "string" ? point.payload.fileHash : undefined;
        if (!file || !fileHash) continue;
        const state = states.get(file);
        if (state) state.pointIds.push(point.id);
        else states.set(file, { fileHash, pointIds: [point.id] });
      }

      return states;
    },
    upsert: async (newPoints) => {
      for (const point of newPoints) points.set(String(point.id), point);
    },
    deletePointIds: async (pointIds) => {
      for (const pointId of pointIds) {
        points.delete(String(pointId));
        deleted.push(String(pointId));
      }
    },
    deleteFile: async (repositoryId, file) => {
      for (const [id, point] of points) {
        if (point.payload.repoId === repositoryId && point.payload.file === file) points.delete(id);
      }
    },
  };
}

test("semantic indexing uses injected providers and preserves unrelated graph state", async () => {
  const repoPath = await temporaryRepository("semantic");
  const filePath = path.join(repoPath, "source.ts");
  const databasePath = path.join(repoPath, ".codeatlas", "atlas.db");
  const vectors = vectorStore();

  try {
    const content = "export function source() { return true; }\n";
    await writeFile(filePath, content);
    const graphStore = new AtlasStore(databasePath);
    const repository = graphStore.ensureRepository(getRepositoryIdentity(repoPath));
    graphStore.setVersion(repository.id, "graph", GRAPH_INDEX_VERSION);
    graphStore.setFileCapabilityState(repository.id, "source.ts", "graph", {
      fileHash: createFileHash(content),
      version: GRAPH_INDEX_VERSION,
      state: "ready",
      itemCount: 1,
    });
    graphStore.close();

    const first = await syncSemantic(repoPath, {
      embeddingProvider: embeddingProvider("1"),
      vectorStore: vectors,
    });
    assert.equal(first.status, "indexed");
    assert.ok(vectors.points.size > 0);

    const stateStore = new AtlasStore(databasePath);
    try {
      const identity = stateStore.ensureRepository(getRepositoryIdentity(repoPath));
      assert.equal(stateStore.getVersion(identity.id, "graph"), GRAPH_INDEX_VERSION);
      assert.equal(stateStore.getFileCapabilityState(identity.id, "source.ts", "graph")?.state, "ready");
      assert.equal(
        stateStore.getFileCapabilityState(identity.id, "source.ts", "semantic")?.providerIdentity,
        "test-embedding@1@2",
      );
    } finally {
      stateStore.close();
    }

    const oldPointCount = vectors.points.size;
    const second = await syncSemantic(repoPath, {
      embeddingProvider: embeddingProvider("2"),
      vectorStore: vectors,
    });
    assert.equal(second.status, "indexed");
    assert.equal(vectors.points.size, oldPointCount);
    assert.equal(vectors.deleted.length, 0);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("semantic version mismatch rebuilds only semantic state and zero-item files become ready", async () => {
  const repoPath = await temporaryRepository("state");
  const databasePath = path.join(repoPath, ".codeatlas", "atlas.db");
  const vectors = vectorStore();

  try {
    await writeFile(path.join(repoPath, "empty.ts"), "// no symbols\n");
    const first = await syncSemantic(repoPath, {
      embeddingProvider: embeddingProvider(),
      vectorStore: vectors,
    });
    assert.equal(first.status, "nothing-to-index");

    const store = new AtlasStore(databasePath);
    try {
      const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
      store.setVersion(repository.id, "graph", GRAPH_INDEX_VERSION);
      store.setFileCapabilityState(repository.id, "empty.ts", "graph", {
        version: GRAPH_INDEX_VERSION,
        state: "ready",
        itemCount: 1,
        fileHash: "graph-hash",
      });
      store.setVersion(repository.id, "semantic", "old-semantic-version");
    } finally {
      store.close();
    }

    const rebuilt = await syncSemantic(repoPath, {
      embeddingProvider: embeddingProvider(),
      vectorStore: vectors,
    });
    assert.equal(rebuilt.fullReindex, true);

    const reopened = new AtlasStore(databasePath);
    try {
      const repository = reopened.ensureRepository(getRepositoryIdentity(repoPath));
      assert.equal(reopened.getVersion(repository.id, "semantic"), VECTOR_INDEX_VERSION);
      assert.equal(reopened.getVersion(repository.id, "graph"), GRAPH_INDEX_VERSION);
      assert.equal(reopened.getFileCapabilityState(repository.id, "empty.ts", "semantic")?.state, "ready");
      assert.equal(reopened.getFileCapabilityState(repository.id, "empty.ts", "semantic")?.itemCount, 0);
      assert.equal(reopened.getFileCapabilityState(repository.id, "empty.ts", "graph")?.fileHash, "graph-hash");
    } finally {
      reopened.close();
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("retrieval remains lexical-only without semantic providers and preserves lexical provenance", async () => {
  const repoPath = await temporaryRepository("lexical-only");

  try {
    await mkdir(path.join(repoPath, "src"), { recursive: true });
    await writeFile(
      path.join(repoPath, "src", "registry.ts"),
      "export function createUserToken() { return true; }\n",
    );
    await indexLexical(repoPath);

    const inspection = await inspectRetrieval("createUserToken", {
      repoPath,
      graphEnabled: false,
    });
    assert.ok(inspection.lexicalResults.length > 0);
    assert.equal(inspection.capabilities.semantic, "not_configured");
    assert.equal(inspection.capabilities.reranker, "not_configured");
    assert.ok(inspection.lexicalResults[0]?.provenance.some((item) => item.stage === "lexical"));
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
