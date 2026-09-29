import assert from "node:assert/strict";
import test from "node:test";

import type { EmbeddingProvider } from "../src/core/semantic/embedding-provider.js";
import { SemanticProviderError } from "../src/core/semantic/semantic-provider-error.js";
import { probeEmbeddingProvider } from "../src/core/semantic/provider-probe.js";

function provider(embedBatch: EmbeddingProvider["embedBatch"], dimensions = 3): EmbeddingProvider {
  return { id: "test", version: "1", dimensions, isAvailable: async () => true, embedBatch };
}

test("provider probe sends one deterministic input and reports dimensions and latency", async () => {
  let input: string[] = [];
  const result = await probeEmbeddingProvider(provider(async (texts) => {
    input = texts;
    return [[0.1, 0.2, 0.3]];
  }));

  assert.deepEqual(input, ["CodeAtlas semantic provider probe."]);
  assert.equal(result.dimensions, 3);
  assert.ok(Number.isFinite(result.latencyMs) && result.latencyMs >= 0);
});

test("provider probe rejects empty, malformed and dimension-mismatched results with typed errors", async (t) => {
  for (const [name, candidate, code] of [
    ["missing vector", provider(async () => []), "SEMANTIC_INVALID_RESPONSE"],
    ["empty vector", provider(async () => [[]]), "SEMANTIC_INVALID_RESPONSE"],
    ["non-finite value", provider(async () => [[0, Number.POSITIVE_INFINITY, 1]]), "SEMANTIC_INVALID_RESPONSE"],
    ["wrong dimension", provider(async () => [[0, 1]]), "SEMANTIC_DIMENSION_MISMATCH"],
  ] as const) {
    await t.test(name, async () => {
      await assert.rejects(probeEmbeddingProvider(candidate), (error: unknown) => error instanceof SemanticProviderError && error.code === code);
    });
  }
});

test("provider probe preserves typed failures and wraps unrelated provider errors", async () => {
  const providerFailure = new SemanticProviderError("SEMANTIC_AUTH_FAILED", "bad credentials");
  await assert.rejects(probeEmbeddingProvider(provider(async () => { throw providerFailure; })), (error) => error === providerFailure);
  await assert.rejects(probeEmbeddingProvider(provider(async () => { throw new Error("runtime broke"); })), (error: unknown) => error instanceof SemanticProviderError && error.code === "SEMANTIC_RUNTIME_FAILED");
});
