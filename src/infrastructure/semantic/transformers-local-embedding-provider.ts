import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { SemanticProviderConfig } from "../../core/config/codeatlas-config.js";
import type { EmbeddingProvider } from "../../core/semantic/embedding-provider.js";
import { SemanticProviderError } from "../../core/semantic/semantic-provider-error.js";

export const DEFAULT_LOCAL_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2";
const DEFAULT_REVISION = "main";

type PipelineOutput = { tolist(): unknown };
export type TransformersFeaturePipeline = (texts: string[], options: { pooling: "mean"; normalize: true }) => Promise<PipelineOutput>;
export type TransformersPipelineOptions = {
  revision: string;
  cache_dir: string;
  local_files_only: boolean;
  device: "cpu";
  progress_callback?: (event: { status: string; progress?: number; file?: string }) => void;
};
export type TransformersPipelineLoader = (
  model: string,
  options: TransformersPipelineOptions,
) => Promise<TransformersFeaturePipeline>;

type TransformersEnvironment = { cacheDir: string | null; allowRemoteModels: boolean };
type TransformersModule = {
  env: TransformersEnvironment;
  pipeline(task: "feature-extraction", model: string, options: TransformersPipelineOptions): Promise<TransformersFeaturePipeline>;
};

let pipelineInitializations = Promise.resolve();

export function withTransformersEnvironment<T>(
  environment: TransformersEnvironment,
  options: TransformersPipelineOptions,
  initialize: () => Promise<T>,
): Promise<T> {
  // ponytail: serialize process-global startup settings; use per-cache locks if concurrent model setup becomes a bottleneck.
  const pending = pipelineInitializations.then(async () => {
    const previousCacheDir = environment.cacheDir;
    const previousAllowRemoteModels = environment.allowRemoteModels;
    environment.cacheDir = options.cache_dir;
    environment.allowRemoteModels = !options.local_files_only;
    try {
      return await initialize();
    } finally {
      environment.cacheDir = previousCacheDir;
      environment.allowRemoteModels = previousAllowRemoteModels;
    }
  });
  pipelineInitializations = pending.then(() => undefined, () => undefined);
  return pending;
}

export type TransformersLocalProviderOptions = {
  runtimeDirectory?: string;
  allowRemoteModels?: boolean;
  loader?: TransformersPipelineLoader;
  fetch?: typeof fetch;
  onProgress?: (event: { status: string; progress?: number; file?: string }) => void;
};

export type ManagedModelIdentity = { model: string; revision: string; dimensions: number };

function modelKey(model: string, revision: string): string {
  return createHash("sha256").update(`${model}\n${revision}`).digest("hex").slice(0, 24);
}

export function managedSemanticRuntimeDirectory(): string {
  return path.join(os.homedir(), ".code-atlas", "runtime", "semantic");
}

export async function resolveHuggingFaceRevision(
  model: string,
  revision: string,
  request: typeof fetch = fetch,
): Promise<string> {
  if (/^[a-f0-9]{40}$/i.test(revision)) return revision.toLowerCase();
  let response: Response;
  try {
    response = await request(`https://huggingface.co/api/models/${model}/revision/${encodeURIComponent(revision)}`, {
      signal: AbortSignal.timeout(30_000),
    });
  } catch (cause) {
    throw new SemanticProviderError("SEMANTIC_PROVIDER_UNREACHABLE", "Could not resolve the local embedding model revision.", { cause });
  }
  if (!response.ok) {
    throw new SemanticProviderError("SEMANTIC_PROVIDER_UNREACHABLE", `Hugging Face returned HTTP ${response.status} while resolving the local embedding model.`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (cause) {
    throw new SemanticProviderError("SEMANTIC_INVALID_RESPONSE", "Hugging Face returned malformed model metadata.", { cause });
  }
  const sha = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>).sha : undefined;
  if (typeof sha !== "string" || !/^[a-f0-9]{40}$/i.test(sha)) {
    throw new SemanticProviderError("SEMANTIC_INVALID_RESPONSE", "Hugging Face model metadata did not contain a commit revision.");
  }
  return sha.toLowerCase();
}

export async function loadTransformersPipeline(
  model: string,
  options: TransformersPipelineOptions,
  transformersModule?: TransformersModule,
): Promise<TransformersFeaturePipeline> {
  const transformers = (transformersModule ?? await import("@huggingface/transformers")) as TransformersModule;
  const modelPath = options.local_files_only ? path.join(options.cache_dir, model, options.revision) : model;
  return withTransformersEnvironment(transformers.env, options, () =>
    transformers.pipeline("feature-extraction", modelPath, options));
}

export function createTransformersLocalEmbeddingProvider(
  input: Extract<SemanticProviderConfig, { type: "builtin-local" }>,
  options: TransformersLocalProviderOptions = {},
): EmbeddingProvider & { readonly model: string; readonly revision: string } {
  const model = input.model ?? DEFAULT_LOCAL_EMBEDDING_MODEL;
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/.test(model)) {
    throw new SemanticProviderError("SEMANTIC_RUNTIME_FAILED", "The managed local model must be a Hugging Face model ID in namespace/name form.");
  }
  const requestedRevision = input.revision ?? DEFAULT_REVISION;
  const runtimeDirectory = options.runtimeDirectory ?? managedSemanticRuntimeDirectory();
  const allowRemoteModels = options.allowRemoteModels ?? false;
  const load = options.loader ?? loadTransformersPipeline;
  let resolvedRevision: string | undefined = /^[a-f0-9]{40}$/i.test(requestedRevision) ? requestedRevision.toLowerCase() : undefined;
  let dimensions = input.dimensions ?? 0;
  let pipelinePromise: Promise<TransformersFeaturePipeline> | undefined;

  async function loadPipeline(): Promise<TransformersFeaturePipeline> {
    if (!resolvedRevision) {
      if (!allowRemoteModels) {
        throw new SemanticProviderError("SEMANTIC_RUNTIME_FAILED", "The local embedding model revision is not pinned; run semantic setup to provision it.");
      }
      resolvedRevision = await resolveHuggingFaceRevision(model, requestedRevision, options.fetch);
    }
    const cacheDirectory = path.join(runtimeDirectory, "models", modelKey(model, resolvedRevision));
    await fs.mkdir(cacheDirectory, { recursive: true });
    return load(model, {
      revision: resolvedRevision,
      cache_dir: cacheDirectory,
      local_files_only: !allowRemoteModels,
      device: "cpu",
      ...(options.onProgress ? { progress_callback: options.onProgress } : {}),
    });
  }

  async function getPipeline(): Promise<TransformersFeaturePipeline> {
    pipelinePromise ??= loadPipeline().catch((error: unknown) => {
      pipelinePromise = undefined;
      if (error instanceof SemanticProviderError) throw error;
      throw new SemanticProviderError("SEMANTIC_RUNTIME_FAILED", "Could not load the managed local embedding model.", { cause: error });
    });
    return pipelinePromise;
  }

  return {
    id: "transformers-local",
    get model() { return model; },
    get revision() { return resolvedRevision ?? requestedRevision; },
    get version() { return `${model}@${resolvedRevision ?? requestedRevision}`; },
    get dimensions() { return dimensions; },
    async isAvailable() {
      if (!resolvedRevision) return false;
      try {
        const metadata = JSON.parse(await fs.readFile(path.join(runtimeDirectory, "versions", `${modelKey(model, resolvedRevision)}.json`), "utf8")) as ManagedModelIdentity;
        return metadata.model === model && metadata.revision === resolvedRevision && metadata.dimensions > 0;
      } catch {
        return false;
      }
    },
    async embedBatch(texts) {
      if (texts.length === 0) return [];
      const pipeline = await getPipeline();
      let result: unknown;
      try {
        result = await pipeline(texts, { pooling: "mean", normalize: true });
      } catch (cause) {
        throw new SemanticProviderError("SEMANTIC_RUNTIME_FAILED", "Managed local embedding inference failed.", { cause });
      }
      const rows = typeof result === "object" && result !== null && "tolist" in result
        ? await (result as PipelineOutput).tolist()
        : result;
      if (!Array.isArray(rows) || rows.length !== texts.length || rows.some((row) => !Array.isArray(row) || row.length === 0 || row.some((value) => typeof value !== "number" || !Number.isFinite(value)))) {
        throw new SemanticProviderError("SEMANTIC_INVALID_RESPONSE", "Managed local model returned malformed embeddings.");
      }
      const vectors = rows as number[][];
      const returnedDimensions = vectors[0]!.length;
      if (vectors.some((vector) => vector.length !== returnedDimensions) || (dimensions > 0 && returnedDimensions !== dimensions)) {
        throw new SemanticProviderError("SEMANTIC_DIMENSION_MISMATCH", "Managed local model returned inconsistent embedding dimensions.");
      }
      dimensions = returnedDimensions;
      return vectors;
    },
  };
}

export async function markManagedModelInstalled(
  runtimeDirectory: string,
  identity: ManagedModelIdentity,
): Promise<void> {
  const key = modelKey(identity.model, identity.revision);
  const versionsDirectory = path.join(runtimeDirectory, "versions");
  await fs.mkdir(versionsDirectory, { recursive: true });
  await atomicWrite(path.join(versionsDirectory, `${key}.json`), `${JSON.stringify(identity, null, 2)}\n`);
  await atomicWrite(path.join(runtimeDirectory, "current.json"), `${JSON.stringify({ version: 1, type: "builtin-local", ...identity }, null, 2)}\n`);
}

async function atomicWrite(destination: string, contents: string): Promise<void> {
  const temporary = `${destination}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, contents, { flag: "wx" });
    await fs.rename(temporary, destination);
  } finally {
    await fs.rm(temporary, { force: true });
  }
}
