import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import type { EmbeddingProvider } from "../src/core/semantic/embedding-provider.js";
import { SemanticProviderError } from "../src/core/semantic/semantic-provider-error.js";
import { inspectHybridSearch } from "../src/core/retrieval/hybrid-search.service.js";
import { createDefaultProviders } from "../src/infrastructure/provider-defaults.js";

async function indexedRepository() {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-semantic-retrieval-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "target.ts"), "export function targetSymbol() { return 'lexical fallback'; }\n");
  const indexed = await indexRepository(root);
  if (indexed.kind === "failed") throw new Error(indexed.failure.message);
  return root;
}

function embeddingProvider(error: Error): EmbeddingProvider {
  return {
    id: "test", version: "1", dimensions: 2,
    isAvailable: async () => true,
    embedBatch: async () => { throw error; },
  };
}

test("typed semantic provider failure leaves lexical retrieval available", async () => {
  const root = await indexedRepository();
  const providers = createDefaultProviders(root, { readOnly: true });
  try {
    const result = await inspectHybridSearch("targetSymbol", 10, root, {
      embeddingProvider: embeddingProvider(new SemanticProviderError("SEMANTIC_PROVIDER_UNREACHABLE", "offline")),
      vectorStore: providers.vectorStore,
      semanticState: "ready",
    });
    assert.equal(result.semanticState, "error");
    assert.ok(result.lexicalResults.length > 0, JSON.stringify(result.lexicalResults));
  } finally {
    (providers.vectorStore as { close?: () => void }).close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("unrelated semantic-path programming errors are not hidden as a lexical-only result", async () => {
  const root = await indexedRepository();
  const providers = createDefaultProviders(root, { readOnly: true });
  try {
    await assert.rejects(inspectHybridSearch("targetSymbol", 10, root, {
      embeddingProvider: embeddingProvider(new Error("programming bug")),
      vectorStore: providers.vectorStore,
      semanticState: "ready",
    }), /programming bug/);
  } finally {
    (providers.vectorStore as { close?: () => void }).close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("semantic retrieval is skipped when the index is not compatible", async () => {
  const root = await indexedRepository();
  const providers = createDefaultProviders(root, { readOnly: true });
  let calls = 0;
  try {
    const result = await inspectHybridSearch("targetSymbol", 10, root, {
      embeddingProvider: {
        id: "test", version: "1", dimensions: 2,
        isAvailable: async () => true,
        embedBatch: async () => { calls += 1; return [[1, 0]]; },
      },
      vectorStore: providers.vectorStore,
    });
    assert.equal(result.semanticState, "not_indexed");
    assert.equal(calls, 0);
    assert.ok(result.lexicalResults.length > 0);
  } finally {
    (providers.vectorStore as { close?: () => void }).close?.();
    await rm(root, { recursive: true, force: true });
  }
});

test("a model identity change marks semantic retrieval stale while lexical results stay available", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-semantic-identity-"));
  await mkdir(path.join(root, "src"));
  await writeFile(path.join(root, "src", "target.ts"), "export function targetSymbol() { return 'identity check'; }\n");
  const providers = createDefaultProviders(root);
  const indexedProvider: EmbeddingProvider = {
    id: "transformers-local", version: "Xenova/all-MiniLM-L6-v2@revision-a", dimensions: 2,
    isAvailable: async () => true,
    embedBatch: async (texts) => texts.map(() => [1, 0]),
  };
  try {
    const indexed = await indexRepository(root, {
      skipGit: true,
      includeSemantic: true,
      semanticProviders: { embeddingProvider: indexedProvider, vectorStore: providers.vectorStore },
    });
    assert.equal(indexed.kind, "published");
    const matching = await inspectHybridSearch("targetSymbol", 10, root, {
      embeddingProvider: indexedProvider, vectorStore: providers.vectorStore,
    });
    assert.equal(matching.semanticState, "ready");
    assert.ok(matching.vectorResults.length > 0);

    let embeddingCalls = 0;
    const changedProvider: EmbeddingProvider = {
      ...indexedProvider,
      version: "Xenova/all-MiniLM-L6-v2@revision-b",
      async embedBatch(texts) { embeddingCalls += 1; return texts.map(() => [0, 1]); },
    };
    const stale = await inspectHybridSearch("targetSymbol", 10, root, {
      embeddingProvider: changedProvider, vectorStore: providers.vectorStore,
    });
    assert.equal(stale.semanticState, "stale");
    assert.equal(stale.vectorResults.length, 0);
    assert.equal(embeddingCalls, 0);
    assert.ok(stale.lexicalResults.length > 0);
  } finally {
    (providers.vectorStore as { close?: () => void }).close?.();
    await rm(root, { recursive: true, force: true });
  }
});
