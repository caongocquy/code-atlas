import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";
import { formatRepositoryStatus } from "../src/adapters/cli/cli-output.js";
import { getRepositoryStatusReadOnly } from "../src/core/repository/repository-status.service.js";
import { syncSemantic } from "../src/core/semantic/semantic-index.service.js";
import { SqliteVectorStore } from "../src/storage/atlas/sqlite-vector.store.js";
import { createSemanticEmbeddingProvider } from "../src/infrastructure/semantic/provider-factory.js";
import { getSemanticStatus } from "../src/infrastructure/semantic/semantic-lifecycle.service.js";
import { writeRepositoryConfig } from "../src/infrastructure/semantic/semantic-config.store.js";

const providerConfig = { type: "openai-compatible" as const, baseUrl: "http://127.0.0.1:9999/v1", model: "test", dimensions: 2 };

async function repository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-semantic-status-"));
  await writeFile(path.join(root, "source.ts"), "export const answer = 42;\n");
  return root;
}

test("persisted semantic configuration controls status even without an Atlas database", async () => {
  const root = await repository();
  try {
    const missing = await getRepositoryStatusReadOnly(root);
    assert.equal(missing.capabilities.semantic.state, "not_configured");
    assert.equal(missing.capabilities.semantic.configured, false);
    assert.equal(missing.capabilities.semantic.enabled, false);

    await writeRepositoryConfig(root, { version: 1, semantic: { enabled: false, provider: providerConfig } });
    const disabled = await getRepositoryStatusReadOnly(root);
    assert.equal(disabled.capabilities.semantic.state, "disabled");
    assert.equal(disabled.capabilities.semantic.configured, true);
    assert.equal(disabled.capabilities.semantic.enabled, false);

    await writeRepositoryConfig(root, { version: 1, semantic: { enabled: true, provider: providerConfig } });
    const enabled = await getRepositoryStatusReadOnly(root);
    assert.equal(enabled.capabilities.semantic.state, "not_indexed");
    assert.equal(enabled.capabilities.semantic.configured, true);
    assert.equal(enabled.capabilities.semantic.enabled, true);
    assert.equal(enabled.graph.reachable, false);
    assert.match(formatRepositoryStatus(enabled), /Semantic\s+○ not_indexed/);

    const lifecycle = await getSemanticStatus(root);
    assert.equal(lifecycle.configured, true);
    assert.equal(lifecycle.enabled, true);
    assert.equal(lifecycle.index.state, "missing");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configured semantic status is ready with a compatible index and unavailable without provider credentials", async () => {
  const root = await repository();
  const vectorStore = new SqliteVectorStore(path.join(root, ".codeatlas", "atlas.db"));
  try {
    await writeRepositoryConfig(root, { version: 1, semantic: { enabled: true, provider: providerConfig } });
    const noIndex = await getRepositoryStatusReadOnly(root);
    assert.equal(noIndex.capabilities.semantic.state, "not_indexed");

    const identity = createSemanticEmbeddingProvider(providerConfig);
    await syncSemantic(root, {
      embeddingProvider: {
        id: identity.id,
        version: identity.version,
        dimensions: identity.dimensions,
        isAvailable: async () => true,
        embedBatch: async (texts) => texts.map(() => [1, 0]),
      },
      vectorStore,
    });

    const ready = await getRepositoryStatusReadOnly(root);
    assert.equal(ready.capabilities.semantic.state, "ready");
    assert.equal(ready.capabilities.semantic.configured, true);
    assert.equal(ready.capabilities.semantic.enabled, true);
    assert.equal((await getSemanticStatus(root)).index.state, "ready");

    await writeRepositoryConfig(root, { version: 1, semantic: { enabled: true, provider: { ...providerConfig, apiKeyEnv: "CODE_ATLAS_STATUS_TEST_MISSING_KEY" } } });
    const unavailable = await getRepositoryStatusReadOnly(root);
    assert.equal(unavailable.capabilities.semantic.state, "unavailable");
    assert.equal(unavailable.capabilities.semantic.configured, true);
    assert.equal(unavailable.capabilities.semantic.enabled, true);
  } finally {
    vectorStore.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("MCP repository status uses persisted semantic configuration without optional provider initialization", async () => {
  const root = await repository();
  const server = createMcpServer();
  const client = new Client({ name: "semantic-status-consistency", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    await writeRepositoryConfig(root, { version: 1, semantic: { enabled: true, provider: providerConfig } });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const response = await client.callTool({ name: "repository_status", arguments: { repoPath: root } });
    const content = response.content.find((item) => item.type === "text");
    assert.ok(content && content.type === "text");
    const status = JSON.parse(content.text);
    assert.deepEqual(status.capabilities.semantic, { state: "not_indexed", indexedFiles: 0, itemCount: 0, configured: true, enabled: true });
  } finally {
    await client.close();
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
