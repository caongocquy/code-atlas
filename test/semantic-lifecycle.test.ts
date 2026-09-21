import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import path from "node:path";
import { once } from "node:events";
import test from "node:test";

import { cleanSemanticIndex, disableSemanticProvider, setupSemanticProvider, testSemanticProvider, getSemanticStatus, upgradeSemanticProvider } from "../src/infrastructure/semantic/semantic-lifecycle.service.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { SqliteVectorStore } from "../src/storage/atlas/sqlite-vector.store.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { GRAPH_INDEX_VERSION, LEXICAL_INDEX_VERSION, VECTOR_INDEX_VERSION } from "../src/config/constants.js";
import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { createDefaultProviders } from "../src/infrastructure/provider-defaults.js";
import { DEFAULT_LOCAL_EMBEDDING_MODEL, type TransformersPipelineLoader } from "../src/infrastructure/semantic/transformers-local-embedding-provider.js";

async function server(status: number, body: unknown = { data: [{ index: 0, embedding: [0.2, 0.4, 0.6] }] }) {
  const requests: Array<{ url: string | undefined; authorization: string | undefined }> = [];
  const instance = createServer((request: IncomingMessage, response: ServerResponse) => {
    requests.push({ url: request.url, authorization: request.headers.authorization });
    response.writeHead(status, { "content-type": "application/json" });
    response.end(JSON.stringify(body));
  });
  instance.listen(0, "127.0.0.1");
  await once(instance, "listening");
  const address = instance.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1`,
    requests,
    async close() {
      instance.closeAllConnections();
      instance.close();
      await once(instance, "close");
    },
  };
}

async function repository() {
  return mkdtemp(path.join(tmpdir(), "code-atlas-semantic-lifecycle-"));
}

async function seedIndex(root: string, indexedRoot = root) {
  const databasePath = path.join(root, ".codeatlas", "atlas.db");
  const store = new AtlasStore(databasePath);
  const repository = store.ensureRepository(getRepositoryIdentity(indexedRoot));
  store.setVersion(repository.id, "graph", GRAPH_INDEX_VERSION);
  store.setVersion(repository.id, "lexical", LEXICAL_INDEX_VERSION);
  store.setVersion(repository.id, "semantic", VECTOR_INDEX_VERSION);
  for (const [capability, version] of [["graph", GRAPH_INDEX_VERSION], ["lexical", LEXICAL_INDEX_VERSION], ["semantic", VECTOR_INDEX_VERSION]] as const) {
    store.setFileCapabilityState(repository.id, "src/kept.ts", capability, {
      fileHash: "kept-hash", version, state: "ready", generation: "generation-1",
      ...(capability === "semantic" ? { providerIdentity: "old@model@2" } : {}), itemCount: 1,
    });
  }
  store.close();
  const vectorStore = new SqliteVectorStore(databasePath, repository.id);
  await vectorStore.ensureCollection(2);
  await vectorStore.upsert([{ id: `point-${repository.id}`, vector: [1, 0], payload: { repoId: repository.id, file: "src/kept.ts", fileHash: "kept-hash", generationId: "generation-1" } }]);
  vectorStore.close();
  return repository.id;
}

function indexSnapshot(root: string, repoPath = root) {
  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"), { readOnly: true });
  try {
    const repository = store.findRepository(getRepositoryIdentity(repoPath));
    if (!repository) return undefined;
    return {
      graph: store.getVersion(repository.id, "graph"),
      lexical: store.getVersion(repository.id, "lexical"),
      semantic: store.getVersion(repository.id, "semantic"),
      semanticFiles: [...store.getFileCapabilityStates(repository.id, "semantic").keys()],
      vectors: store.countSemanticVectors(repository.id),
    };
  } finally {
    store.close();
  }
}

test("semantic setup probes before saving config and never indexes", async () => {
  const root = await repository();
  const endpoint = await server(200);
  const configPath = path.join(root, "codeatlas.config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, gate: { enabled: true } }));
  try {
    const result = await setupSemanticProvider(root, {
      type: "openai-compatible", baseUrl: endpoint.baseUrl, model: "embed-v1",
    });
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(result.status, "configured");
    assert.equal(result.probe.dimensions, 3);
    assert.equal(result.indexChanged, false);
    assert.deepEqual(saved.gate, { enabled: true });
    assert.equal(saved.version, 1);
    assert.deepEqual(saved.semantic.provider, {
      type: "openai-compatible", baseUrl: endpoint.baseUrl, model: "embed-v1", dimensions: 3,
    });
    await assert.rejects(readFile(path.join(root, ".codeatlas", "atlas.db")));
  } finally {
    await endpoint.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("missing API key documents the env name without changing provider config or semantic index", async () => {
  const root = await repository();
  await seedIndex(root);
  const configPath = path.join(root, "codeatlas.config.json");
  const initial = JSON.stringify({ version: 1, semantic: { enabled: true, provider: { type: "openai-compatible", baseUrl: "http://localhost:8080/v1", model: "old", dimensions: 2 } } }, null, 2);
  await writeFile(configPath, initial);
  const previousIndex = indexSnapshot(root);
  const previous = process.env.OPENAI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  try {
    const result = await setupSemanticProvider(root, {
      type: "openai-compatible", baseUrl: "http://localhost:8081/v1", model: "candidate", apiKeyEnv: "OPENAI_API_KEY",
    });
    assert.deepEqual(result, {
      status: "missing_env", code: "SEMANTIC_MISSING_ENV", env: "OPENAI_API_KEY", configChanged: false, indexChanged: false,
    });
    assert.equal(await readFile(configPath, "utf8"), initial);
    assert.deepEqual(indexSnapshot(root), previousIndex);
    assert.match(await readFile(path.join(root, ".env.example"), "utf8"), /^OPENAI_API_KEY=$/m);
  } finally {
    if (previous === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = previous;
    await rm(root, { recursive: true, force: true });
  }
});

test("failed provider probe leaves the existing semantic provider config intact", async () => {
  const root = await repository();
  const endpoint = await server(500, { error: "offline" });
  await seedIndex(root);
  const configPath = path.join(root, "codeatlas.config.json");
  const initial = JSON.stringify({ version: 1, semantic: { enabled: true, provider: { type: "openai-compatible", baseUrl: "http://old/v1", model: "old", dimensions: 3 } } });
  await writeFile(configPath, initial);
  const previousIndex = indexSnapshot(root);
  try {
    await assert.rejects(setupSemanticProvider(root, {
      type: "openai-compatible", baseUrl: endpoint.baseUrl, model: "candidate",
    }));
    assert.equal(await readFile(configPath, "utf8"), initial);
    assert.deepEqual(indexSnapshot(root), previousIndex);
  } finally {
    await endpoint.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic test probes the saved provider without mutating config or index", async () => {
  const root = await repository();
  const endpoint = await server(200);
  const configPath = path.join(root, "codeatlas.config.json");
  const initial = JSON.stringify({ version: 1, semantic: { enabled: true, provider: { type: "openai-compatible", baseUrl: endpoint.baseUrl, model: "embed-v1", dimensions: 3 } } });
  await writeFile(configPath, initial);
  try {
    const result = await testSemanticProvider(root);
    assert.equal(result.probe.dimensions, 3);
    assert.equal(result.configChanged, false);
    assert.equal(result.indexChanged, false);
    assert.equal(await readFile(configPath, "utf8"), initial);
    assert.equal(endpoint.requests.length, 1);
    await assert.rejects(readFile(path.join(root, ".codeatlas", "atlas.db")));
  } finally {
    await endpoint.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic status is local-only and does not probe the configured provider", async () => {
  const root = await repository();
  const endpoint = await server(200);
  await writeFile(path.join(root, "codeatlas.config.json"), JSON.stringify({
    version: 1, semantic: { enabled: true, provider: { type: "openai-compatible", baseUrl: endpoint.baseUrl, model: "embed-v1", dimensions: 3 } },
  }));
  try {
    const result = await getSemanticStatus(root);
    assert.equal(result.configured, true);
    assert.equal(result.enabled, true);
    assert.equal(endpoint.requests.length, 0);
    await assert.rejects(readFile(path.join(root, ".codeatlas", "atlas.db")));
  } finally {
    await endpoint.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic disable changes only the enabled flag and preserves vectors and index metadata", async () => {
  const root = await repository();
  await seedIndex(root);
  const configPath = path.join(root, "codeatlas.config.json");
  const provider = { type: "openai-compatible", baseUrl: "http://localhost:8080/v1", model: "embed-v1", dimensions: 2 };
  await writeFile(configPath, JSON.stringify({ version: 1, semantic: { enabled: true, provider } }));
  const before = indexSnapshot(root);
  try {
    const result = await disableSemanticProvider(root);
    const saved = JSON.parse(await readFile(configPath, "utf8"));
    assert.equal(result.status, "disabled");
    assert.equal(result.indexChanged, false);
    assert.deepEqual(saved.semantic, { enabled: false, provider });
    assert.deepEqual(indexSnapshot(root), before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic clean removes only this repository's semantic vectors and metadata", async () => {
  const root = await repository();
  const otherRoot = path.join(root, "other");
  await mkdir(otherRoot);
  await seedIndex(root, otherRoot);
  await seedIndex(root);
  const configPath = path.join(root, "codeatlas.config.json");
  const initial = JSON.stringify({ version: 1, semantic: { enabled: false, provider: { type: "openai-compatible", baseUrl: "http://localhost:8080/v1", model: "embed-v1", dimensions: 2 } } });
  await writeFile(configPath, initial);
  try {
    const result = await cleanSemanticIndex(root);
    assert.equal(result.status, "cleaned");
    assert.equal(result.vectors, 1);
    assert.equal(result.files, 1);
    assert.deepEqual(indexSnapshot(root), {
      graph: GRAPH_INDEX_VERSION, lexical: LEXICAL_INDEX_VERSION, semantic: undefined,
      semanticFiles: [], vectors: 0,
    });
    assert.deepEqual(indexSnapshot(root, otherRoot), {
      graph: GRAPH_INDEX_VERSION, lexical: LEXICAL_INDEX_VERSION, semantic: VECTOR_INDEX_VERSION,
      semanticFiles: ["src/kept.ts"], vectors: 1,
    });
    assert.equal(await readFile(configPath, "utf8"), initial);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic clean removes versioned vectors but preserves the active graph and lexical generation", async () => {
  const root = await repository();
  await writeFile(path.join(root, "source.ts"), "export function source() { return 1; }\n");
  const providers = createDefaultProviders(root);
  try {
    const result = await indexRepository(root, {
      skipGit: true,
      includeSemantic: true,
      semanticProviders: {
        embeddingProvider: {
          id: "test", version: "model-a", dimensions: 3,
          isAvailable: async () => true,
          embedBatch: async (texts) => texts.map(() => [0.1, 0.2, 0.3]),
        },
        vectorStore: providers.vectorStore,
      },
    });
    assert.equal(result.kind, "published");
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    const repository = store.ensureRepository(getRepositoryIdentity(root));
    const activeGeneration = store.getActiveGenerationId(repository.id);
    assert.ok(activeGeneration);
    assert.ok(store.countSemanticVectors(repository.id) > 0);
    store.close();

    const cleaned = await cleanSemanticIndex(root);
    assert.ok(cleaned.vectors > 0);
    const after = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      assert.equal(after.getActiveGenerationId(repository.id), activeGeneration);
      assert.equal(after.countSemanticVectors(repository.id), 0);
      assert.equal(after.getVersion(repository.id, "semantic"), undefined);
      assert.equal(after.getVersion(repository.id, "graph"), GRAPH_INDEX_VERSION);
      assert.equal(after.getVersion(repository.id, "lexical"), LEXICAL_INDEX_VERSION);
      assert.equal(after.hasActiveSemanticCapability(repository.id), false);
    } finally {
      after.close();
    }
    const reindexed = await indexRepository(root, {
      skipGit: true,
      includeSemantic: true,
      semanticProviders: {
        embeddingProvider: {
          id: "test", version: "model-b", dimensions: 4,
          isAvailable: async () => true,
          embedBatch: async (texts) => texts.map(() => [0.1, 0.2, 0.3, 0.4]),
        },
        vectorStore: providers.vectorStore,
      },
    });
    assert.equal(reindexed.kind, "published");
    const rebuilt = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      assert.ok(rebuilt.countSemanticVectors(repository.id) > 0);
      assert.equal(rebuilt.getVersion(repository.id, "semantic"), VECTOR_INDEX_VERSION);
    } finally {
      rebuilt.close();
    }
  } finally {
    providers.vectorStore.close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic upgrade reports OpenAI-compatible providers as externally managed", async () => {
  const root = await repository();
  const configPath = path.join(root, "codeatlas.config.json");
  const initial = JSON.stringify({ version: 1, semantic: { enabled: true, provider: { type: "openai-compatible", baseUrl: "http://localhost:8080/v1", model: "embed-v1", dimensions: 3 } } });
  await writeFile(configPath, initial);
  try {
    const result = await upgradeSemanticProvider(root);
    assert.equal(result.status, "externally_managed");
    assert.match(result.message, /semantic setup/i);
    assert.equal(await readFile(configPath, "utf8"), initial);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("managed local setup pins, probes, and activates a model without indexing", async () => {
  const root = await repository();
  const runtimeDirectory = await repository();
  const revision = "b".repeat(40);
  const loader: TransformersPipelineLoader = async (_model, options) => {
    assert.equal(options.local_files_only, false);
    return async (texts) => ({ tolist: () => texts.map(() => [0.1, 0.2, 0.3]) });
  };
  try {
    const result = await setupSemanticProvider(root, { type: "builtin-local" }, {
      runtimeDirectory,
      loader,
      fetch: async () => new Response(JSON.stringify({ sha: revision }), { status: 200 }),
    });
    const saved = JSON.parse(await readFile(path.join(root, "codeatlas.config.json"), "utf8"));
    assert.equal(result.status, "configured");
    assert.deepEqual(saved.semantic.provider, {
      type: "builtin-local", model: DEFAULT_LOCAL_EMBEDDING_MODEL, revision, dimensions: 3,
    });
    assert.equal(result.indexChanged, false);
    assert.deepEqual(JSON.parse(await readFile(path.join(runtimeDirectory, "current.json"), "utf8")), {
      version: 1, type: "builtin-local", model: DEFAULT_LOCAL_EMBEDDING_MODEL, revision, dimensions: 3,
    });
    await assert.rejects(readFile(path.join(root, ".codeatlas", "atlas.db")));
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("failed managed local candidate leaves provider config and active runtime metadata unchanged", async () => {
  const root = await repository();
  const runtimeDirectory = await repository();
  const configPath = path.join(root, "codeatlas.config.json");
  const initial = JSON.stringify({ version: 1, semantic: { enabled: true, provider: { type: "openai-compatible", baseUrl: "http://localhost:8080/v1", model: "old", dimensions: 2 } } });
  const current = JSON.stringify({ version: 1, type: "builtin-local", model: "Xenova/old-model", revision: "c".repeat(40), dimensions: 2 });
  await writeFile(configPath, initial);
  await writeFile(path.join(runtimeDirectory, "current.json"), current);
  const loader: TransformersPipelineLoader = async () => { throw new Error("candidate load failed"); };
  try {
    await assert.rejects(setupSemanticProvider(root, { type: "builtin-local" }, {
      runtimeDirectory,
      loader,
      fetch: async () => new Response(JSON.stringify({ sha: "d".repeat(40) }), { status: 200 }),
    }));
    assert.equal(await readFile(configPath, "utf8"), initial);
    assert.equal(await readFile(path.join(runtimeDirectory, "current.json"), "utf8"), current);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("built-in upgrade switches to the probed model revision and reports runtime-only identity separately", async () => {
  const root = await repository();
  const runtimeDirectory = await repository();
  const nextRevision = "e".repeat(40);
  const configPath = path.join(root, "codeatlas.config.json");
  await writeFile(configPath, JSON.stringify({ version: 1, semantic: { enabled: true, provider: {
    type: "builtin-local", model: DEFAULT_LOCAL_EMBEDDING_MODEL, revision: "f".repeat(40), dimensions: 3,
  } } }));
  const loader: TransformersPipelineLoader = async () => async (texts) => ({ tolist: () => texts.map(() => [0.2, 0.3, 0.4]) });
  try {
    const result = await upgradeSemanticProvider(root, {
      runtimeDirectory,
      loader,
      fetch: async () => new Response(JSON.stringify({ sha: nextRevision }), { status: 200 }),
    });
    assert.equal(result.status, "upgraded");
    assert.deepEqual(JSON.parse(await readFile(configPath, "utf8")).semantic.provider, {
      type: "builtin-local", model: DEFAULT_LOCAL_EMBEDDING_MODEL, revision: nextRevision, dimensions: 3,
    });
    assert.equal(result.indexChanged, false);
    assert.equal(JSON.parse(await readFile(path.join(runtimeDirectory, "current.json"), "utf8")).revision, nextRevision);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("failed managed local upgrade preserves the previous provider and current model", async () => {
  const root = await repository();
  const runtimeDirectory = await repository();
  const configPath = path.join(root, "codeatlas.config.json");
  const initial = JSON.stringify({ version: 1, semantic: { enabled: true, provider: {
    type: "builtin-local", model: DEFAULT_LOCAL_EMBEDDING_MODEL, revision: "a".repeat(40), dimensions: 3,
  } } });
  const current = JSON.stringify({ version: 1, type: "builtin-local", model: DEFAULT_LOCAL_EMBEDDING_MODEL, revision: "a".repeat(40), dimensions: 3 });
  await writeFile(configPath, initial);
  await writeFile(path.join(runtimeDirectory, "current.json"), current);
  const loader: TransformersPipelineLoader = async () => { throw new Error("candidate load failed"); };
  try {
    await assert.rejects(upgradeSemanticProvider(root, {
      runtimeDirectory,
      loader,
      fetch: async () => new Response(JSON.stringify({ sha: "b".repeat(40) }), { status: 200 }),
    }));
    assert.equal(await readFile(configPath, "utf8"), initial);
    assert.equal(await readFile(path.join(runtimeDirectory, "current.json"), "utf8"), current);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});
