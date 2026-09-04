import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";
import { syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { syncSemantic } from "../src/core/semantic/semantic-index.service.js";
import type { EmbeddingProvider } from "../src/core/semantic/embedding-provider.js";
import type { VectorStore } from "../src/core/semantic/vector-store.js";
import { getRepositoryStatus } from "../src/core/repository/repository-status.service.js";
import { SqliteVectorStore } from "../src/storage/atlas/sqlite-vector.store.js";

function configuredEmbeddingProvider(): EmbeddingProvider {
  return {
    id: "test-embedding",
    version: "1",
    dimensions: 2,
    isAvailable: async () => true,
    embedBatch: async (texts) => texts.map(() => [1, 0]),
  };
}

function emptyVectorStore(): VectorStore {
  return {
    id: "sqlite",
    isAvailable: async () => true,
    ensureCollection: async () => undefined,
    search: async () => [],
    count: async () => 0,
    getIndexedFileStates: async () => new Map(),
    upsert: async () => undefined,
    deletePointIds: async () => undefined,
    deleteFile: async () => undefined,
  };
}

async function temporaryRepository(name: string): Promise<string> {
  const repoPath = await mkdtemp(path.join(tmpdir(), `code-atlas-capability-${name}-`));
  await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");
  return repoPath;
}

test("configured but never-indexed semantic and vector capabilities are not stale", async () => {
  const repoPath = await temporaryRepository("never-indexed");

  try {
    const status = await getRepositoryStatus(repoPath, {
      embeddingProvider: configuredEmbeddingProvider(),
      vectorStore: emptyVectorStore(),
    });

    assert.equal(status.capabilities.semantic.state, "not_indexed");
    assert.equal(status.vector.status, "not_indexed");
    assert.equal(status.vector.needsSync, false);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("graph and lexical sync does not create optional semantic maintenance work", async () => {
  const repoPath = await temporaryRepository("sync");

  try {
    await syncRepository(repoPath, { skipGit: true });
    const providers = {
      embeddingProvider: configuredEmbeddingProvider(),
      vectorStore: emptyVectorStore(),
    };
    const afterSync = await getRepositoryStatus(repoPath, providers);
    const afterSecondStatus = await getRepositoryStatus(repoPath, providers);

    assert.equal(afterSync.graph.status, "ready");
    assert.equal(afterSync.capabilities.lexical.state, "ready");
    assert.equal(afterSync.capabilities.semantic.state, "not_indexed");
    assert.equal(afterSync.vector.status, "not_indexed");
    assert.equal(afterSync.vector.needsSync, false);
    assert.deepEqual(
      {
        semantic: afterSecondStatus.capabilities.semantic.state,
        vector: afterSecondStatus.vector.status,
        needsSync: afterSecondStatus.vector.needsSync,
      },
      {
        semantic: "not_indexed",
        vector: "not_indexed",
        needsSync: false,
      },
    );
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("indexed semantic and vector capabilities become stale only after source changes", async () => {
  const repoPath = await temporaryRepository("indexed");
  const databasePath = path.join(repoPath, ".codeatlas", "atlas.db");
  const provider = configuredEmbeddingProvider();
  const vectorStore = new SqliteVectorStore(databasePath);

  try {
    await syncSemantic(repoPath, {
      embeddingProvider: provider,
      vectorStore,
    });

    const fresh = await getRepositoryStatus(repoPath, {
      embeddingProvider: provider,
      vectorStore,
    });
    assert.equal(fresh.capabilities.semantic.state, "ready");
    assert.equal(fresh.vector.status, "ready");
    assert.equal(fresh.vector.needsSync, false);

    await writeFile(path.join(repoPath, "source.ts"), "export function changed() { return false; }\n");
    const stale = await getRepositoryStatus(repoPath, {
      embeddingProvider: provider,
      vectorStore,
    });
    assert.equal(stale.capabilities.semantic.state, "stale");
    assert.equal(stale.vector.status, "stale");
    assert.equal(stale.vector.needsSync, true);

    const unconfigured = await getRepositoryStatus(repoPath);
    assert.equal(unconfigured.capabilities.semantic.state, "not_configured");
    assert.equal(unconfigured.vector.status, "stale");
    assert.equal(unconfigured.vector.needsSync, false);
  } finally {
    vectorStore.close();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("reranker readiness is stateless provider availability", async () => {
  const repoPath = await temporaryRepository("reranker");

  try {
    const status = await getRepositoryStatus(repoPath, {
      rerankerProvider: {
        id: "test-reranker",
        version: "1",
        isAvailable: async () => true,
        rerank: async <T>(
          _query: string,
          candidates: T[],
          limit: number,
        ) => candidates.slice(0, limit).map((candidate) => ({ ...candidate, rerankScore: 1 })),
      },
    });

    assert.equal(status.capabilities.reranker.state, "ready");
    assert.equal(status.capabilities.reranker.indexedFiles, 0);
    assert.equal(status.capabilities.reranker.itemCount, 0);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("MCP status stays stable after graph and lexical sync", async () => {
  const repoPath = await temporaryRepository("mcp-sync");
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "capability-state-regression", version: "1" });

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const status = async () => {
      const result = await client.callTool({
        name: "repository_status",
        arguments: { repoPath },
      });
      const text = result.content.find((item) => item.type === "text");
      assert.ok(text && text.type === "text");
      return JSON.parse(text.text) as {
        graph: { status: string };
        capabilities: {
          lexical: { state: string };
          semantic: { state: string };
        };
        vector: { status: string; needsSync: boolean };
      };
    };

    const before = await status();
    assert.equal(before.capabilities.semantic.state, "not_configured");
    assert.equal(before.vector.status, "not_indexed");
    assert.equal(before.vector.needsSync, false);

    const sync = await client.callTool({
      name: "sync_repository",
      arguments: { repoPath, skipGit: true },
    });
    assert.equal(sync.isError, undefined);

    const after = await status();
    const repeatedSync = await client.callTool({
      name: "sync_repository",
      arguments: { repoPath, skipGit: true },
    });
    assert.equal(repeatedSync.isError, undefined);
    const afterAgain = await status();
    assert.deepEqual(
      {
        graph: after.graph.status,
        lexical: after.capabilities.lexical.state,
        semantic: after.capabilities.semantic.state,
        vector: after.vector.status,
        needsSync: after.vector.needsSync,
      },
      {
        graph: "ready",
        lexical: "ready",
        semantic: "not_configured",
        vector: "not_indexed",
        needsSync: false,
      },
    );
    assert.deepEqual(
      {
        graph: afterAgain.graph.status,
        lexical: afterAgain.capabilities.lexical.state,
        semantic: afterAgain.capabilities.semantic.state,
        vector: afterAgain.vector.status,
        needsSync: afterAgain.vector.needsSync,
      },
      {
        graph: "ready",
        lexical: "ready",
        semantic: "not_configured",
        vector: "not_indexed",
        needsSync: false,
      },
    );
  } finally {
    await client.close();
    await server.close();
    await rm(repoPath, { recursive: true, force: true });
  }
});
