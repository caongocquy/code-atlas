import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createTransformersLocalEmbeddingProvider,
  loadTransformersPipeline,
  markManagedModelInstalled,
  resolveHuggingFaceRevision,
  type TransformersPipelineLoader,
  withTransformersEnvironment,
} from "../src/infrastructure/semantic/transformers-local-embedding-provider.js";

const revision = "a".repeat(40);

test("resolves mutable Hugging Face revisions to an immutable commit", async () => {
  const result = await resolveHuggingFaceRevision("Xenova/all-MiniLM-L6-v2", "main", async (input) => {
    assert.equal(String(input), "https://huggingface.co/api/models/Xenova/all-MiniLM-L6-v2/revision/main");
    return new Response(JSON.stringify({ sha: revision }), { status: 200 });
  });
  assert.equal(result, revision);
});

test("pipeline initialization uses the managed cache and offline policy without leaking Transformers.js globals", async () => {
  const environment = { cacheDir: "/library-cache", allowRemoteModels: true };
  const options = {
    revision,
    cache_dir: "/managed-cache/model",
    local_files_only: true,
    device: "cpu" as const,
  };
  let active = 0;
  let peak = 0;

  await Promise.all([
    withTransformersEnvironment(environment, options, async () => {
      active++;
      peak = Math.max(peak, active);
      assert.equal(environment.cacheDir, options.cache_dir);
      assert.equal(environment.allowRemoteModels, false);
      await new Promise((resolve) => setTimeout(resolve, 10));
      active--;
    }),
    withTransformersEnvironment(environment, { ...options, cache_dir: "/managed-cache/other" }, async () => {
      active++;
      peak = Math.max(peak, active);
      assert.equal(environment.cacheDir, "/managed-cache/other");
      assert.equal(environment.allowRemoteModels, false);
      active--;
    }),
  ]);

  assert.equal(peak, 1);
  assert.equal(environment.cacheDir, "/library-cache");
  assert.equal(environment.allowRemoteModels, true);
});

test("offline pipeline loads the pinned model from the managed local directory", async () => {
  const environment = { cacheDir: "/library-cache", allowRemoteModels: true };
  const options = {
    revision,
    cache_dir: "/managed-cache/model-key",
    local_files_only: true,
    device: "cpu" as const,
  };
  let selectedModel = "";
  const loader = await loadTransformersPipeline("Xenova/all-MiniLM-L6-v2", options, {
    env: environment,
    pipeline: async (_task, model, passedOptions) => {
      selectedModel = model;
      assert.deepEqual(passedOptions, options);
      assert.equal(environment.cacheDir, options.cache_dir);
      assert.equal(environment.allowRemoteModels, false);
      return async (texts) => ({ tolist: () => texts.map(() => [0.1, 0.2]) });
    },
  });

  assert.equal(selectedModel, path.join(options.cache_dir, "Xenova/all-MiniLM-L6-v2", revision));
  assert.deepEqual(await loader(["offline"], { pooling: "mean", normalize: true }).then((output) => output.tolist()), [[0.1, 0.2]]);
  assert.equal(environment.cacheDir, "/library-cache");
  assert.equal(environment.allowRemoteModels, true);
});

test("local provider loads Transformers.js in-process from the managed cache and returns pooled vectors", async () => {
  const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "code-atlas-transformers-"));
  let loadOptions: Record<string, unknown> | undefined;
  const loader: TransformersPipelineLoader = async (model, options) => {
    loadOptions = { model, ...options };
    return async (texts) => ({ tolist: () => texts.map(() => [0.1, 0.2, 0.3]) });
  };
  try {
    const provider = createTransformersLocalEmbeddingProvider({
      type: "builtin-local", model: "Xenova/all-MiniLM-L6-v2", revision,
    }, { runtimeDirectory, loader });
    assert.deepEqual(await provider.embedBatch(["one", "two"]), [[0.1, 0.2, 0.3], [0.1, 0.2, 0.3]]);
    assert.equal(provider.dimensions, 3);
    assert.equal(loadOptions?.device, "cpu");
    assert.equal(loadOptions?.local_files_only, true);
    assert.equal(String(loadOptions?.cache_dir).startsWith(path.join(runtimeDirectory, "models")), true);
    assert.equal(String(loadOptions?.revision), revision);
    assert.equal(provider.version.includes(revision), true);
    assert.equal(provider.version.includes("transformers"), false);
  } finally {
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});

test("managed local availability is offline and requires a committed model manifest", async () => {
  const runtimeDirectory = await mkdtemp(path.join(os.tmpdir(), "code-atlas-transformers-"));
  const config = { type: "builtin-local" as const, model: "Xenova/all-MiniLM-L6-v2", revision, dimensions: 3 };
  const loader: TransformersPipelineLoader = async () => async (texts) => ({ tolist: () => texts.map(() => [1, 0, 0]) });
  try {
    const provider = createTransformersLocalEmbeddingProvider(config, { runtimeDirectory, loader });
    assert.equal(await provider.isAvailable(), false);
    await markManagedModelInstalled(runtimeDirectory, config);
    assert.equal(await provider.isAvailable(), true);
    const active = JSON.parse(await readFile(path.join(runtimeDirectory, "current.json"), "utf8"));
    assert.deepEqual(active, { version: 1, type: "builtin-local", model: config.model, revision, dimensions: 3 });
  } finally {
    await rm(runtimeDirectory, { recursive: true, force: true });
  }
});
