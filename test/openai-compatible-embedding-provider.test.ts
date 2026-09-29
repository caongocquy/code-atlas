import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { once } from "node:events";
import test from "node:test";

import { createOpenAICompatibleEmbeddingProvider } from "../src/infrastructure/semantic/openai-compatible-embedding-provider.js";
import { SemanticProviderError } from "../src/core/semantic/semantic-provider-error.js";

type Handler = (request: IncomingMessage, response: ServerResponse) => void;

async function endpoint(handler: Handler): Promise<{ baseUrl: string; close(): Promise<void> }> {
  const server = createServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return {
    baseUrl: `http://127.0.0.1:${address.port}/v1/`,
    async close() {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

function response(status = 200, body: unknown = { data: [{ index: 0, embedding: [0.25, -0.5] }] }): Handler {
  return (_request, result) => {
    result.writeHead(status, { "content-type": "application/json" });
    result.end(typeof body === "string" ? body : JSON.stringify(body));
  };
}

test("OpenAI-compatible provider posts model/input, resolves auth by env name, and normalizes endpoint identity", async () => {
  let requestCount = 0;
  const server = await endpoint((request, result) => {
    requestCount += 1;
    assert.equal(request.url, "/v1/embeddings");
    assert.equal(request.headers.authorization, "Bearer test-secret");
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk: string) => { body += chunk; });
    request.on("end", () => {
      assert.deepEqual(JSON.parse(body), { model: "embed-v1", input: ["probe"] });
      response()(request, result);
    });
  });

  try {
    const first = createOpenAICompatibleEmbeddingProvider({
      type: "openai-compatible", baseUrl: server.baseUrl, model: "embed-v1", apiKeyEnv: "TEST_EMBED_KEY",
    }, { env: { TEST_EMBED_KEY: "test-secret" } });
    const second = createOpenAICompatibleEmbeddingProvider({
      type: "openai-compatible", baseUrl: server.baseUrl.slice(0, -1), model: "embed-v1", apiKeyEnv: "TEST_EMBED_KEY",
    }, { env: { TEST_EMBED_KEY: "different-secret" } });
    const otherModel = createOpenAICompatibleEmbeddingProvider({
      type: "openai-compatible", baseUrl: server.baseUrl, model: "embed-v2", dimensions: 2,
    });
    const otherDimensions = createOpenAICompatibleEmbeddingProvider({
      type: "openai-compatible", baseUrl: server.baseUrl, model: "embed-v1", dimensions: 3,
    });

    assert.deepEqual(await first.embedBatch(["probe"]), [[0.25, -0.5]]);
    assert.equal(first.dimensions, 2);
    assert.equal(first.id, second.id);
    assert.equal(first.version, second.version);
    assert.notEqual(first.version, otherModel.version);
    assert.notEqual(first.dimensions, otherDimensions.dimensions);
    assert.equal(`${first.id}@${first.version}@${first.dimensions}`.includes("test-secret"), false);
    assert.equal(requestCount, 1);
  } finally {
    await server.close();
  }
});

test("OpenAI-compatible endpoints without an auth env send no Authorization header", async () => {
  const server = await endpoint((request, result) => {
    assert.equal(request.headers.authorization, undefined);
    response()(request, result);
  });
  try {
    const provider = createOpenAICompatibleEmbeddingProvider({
      type: "openai-compatible", baseUrl: server.baseUrl, model: "embed-v1",
    });
    assert.deepEqual(await provider.embedBatch(["probe"]), [[0.25, -0.5]]);
  } finally {
    await server.close();
  }
});

test("missing configured API key is a typed error and never sends a request", async () => {
  assert.throws(() => createOpenAICompatibleEmbeddingProvider({
    type: "openai-compatible", baseUrl: "http://127.0.0.1:1/v1", model: "embed-v1", apiKeyEnv: "MISSING_EMBED_KEY",
  }, { env: {} }), (error: unknown) => {
    assert.ok(error instanceof SemanticProviderError);
    assert.equal(error.code, "SEMANTIC_MISSING_ENV");
    assert.equal(error.env, "MISSING_EMBED_KEY");
    return true;
  });
});

test("provider statuses map auth, throttling, server and timeout failures to stable semantic errors", async (t) => {
  for (const [status, code] of [[401, "SEMANTIC_AUTH_FAILED"], [403, "SEMANTIC_AUTH_FAILED"], [429, "SEMANTIC_PROVIDER_UNREACHABLE"], [500, "SEMANTIC_PROVIDER_UNREACHABLE"]] as const) {
    await t.test(String(status), async () => {
      const server = await endpoint(response(status, { error: "provider failure" }));
      try {
        const provider = createOpenAICompatibleEmbeddingProvider({ type: "openai-compatible", baseUrl: server.baseUrl, model: "embed-v1" });
        await assert.rejects(provider.embedBatch(["probe"]), (error: unknown) => error instanceof SemanticProviderError && error.code === code);
      } finally {
        await server.close();
      }
    });
  }

  await t.test("timeout", async () => {
    const server = await endpoint((_request, result) => { setTimeout(() => result.end("{}"), 100); });
    try {
      const provider = createOpenAICompatibleEmbeddingProvider({ type: "openai-compatible", baseUrl: server.baseUrl, model: "embed-v1" }, { timeoutMs: 5 });
      await assert.rejects(provider.embedBatch(["probe"]), (error: unknown) => error instanceof SemanticProviderError && error.code === "SEMANTIC_PROVIDER_UNREACHABLE");
    } finally {
      await server.close();
    }
  });

  await t.test("connection failure", async () => {
    const server = await endpoint(response());
    const provider = createOpenAICompatibleEmbeddingProvider({ type: "openai-compatible", baseUrl: server.baseUrl, model: "embed-v1" });
    await server.close();
    await assert.rejects(provider.embedBatch(["probe"]), (error: unknown) => error instanceof SemanticProviderError && error.code === "SEMANTIC_PROVIDER_UNREACHABLE");
  });
});

test("malformed JSON, vector counts, empty vectors, non-finite values and dimensions fail closed", async (t) => {
  const cases: Array<[string, string[], unknown, string]> = [
    ["malformed JSON", ["one"], "{", "SEMANTIC_INVALID_RESPONSE"],
    ["wrong vector count", ["one", "two"], { data: [] }, "SEMANTIC_INVALID_RESPONSE"],
    ["empty vector", ["one"], { data: [{ embedding: [] }] }, "SEMANTIC_INVALID_RESPONSE"],
    ["non-finite values", ["one"], { data: [{ embedding: [Number.NaN, 1] }] }, "SEMANTIC_INVALID_RESPONSE"],
    ["inconsistent dimensions", ["one", "two"], { data: [{ embedding: [1, 2] }, { embedding: [1] }] }, "SEMANTIC_DIMENSION_MISMATCH"],
  ];
  for (const [name, inputs, body, code] of cases) {
    await t.test(name, async () => {
      const server = await endpoint(response(200, body));
      try {
        const provider = createOpenAICompatibleEmbeddingProvider({ type: "openai-compatible", baseUrl: server.baseUrl, model: "embed-v1" });
        await assert.rejects(provider.embedBatch(inputs), (error: unknown) => error instanceof SemanticProviderError && error.code === code);
      } finally {
        await server.close();
      }
    });
  }
  await t.test("configured dimension mismatch", async () => {
    const server = await endpoint(response());
    try {
      const provider = createOpenAICompatibleEmbeddingProvider({ type: "openai-compatible", baseUrl: server.baseUrl, model: "embed-v1", dimensions: 3 });
      await assert.rejects(provider.embedBatch(["one"]), (error: unknown) => error instanceof SemanticProviderError && error.code === "SEMANTIC_DIMENSION_MISMATCH");
    } finally {
      await server.close();
    }
  });
});

test("provider validates endpoint and model at the configuration boundary", () => {
  for (const config of [
    { type: "openai-compatible", baseUrl: "", model: "m" },
    { type: "openai-compatible", baseUrl: "not a URL", model: "m" },
    { type: "openai-compatible", baseUrl: "http://localhost", model: " " },
  ]) {
    assert.throws(() => createOpenAICompatibleEmbeddingProvider(config as never), Error);
  }
});
