import { createHash } from "node:crypto";

import type { SemanticProviderConfig } from "../../core/config/codeatlas-config.js";
import { parseSemanticProviderConfig } from "../../core/config/codeatlas-config.js";
import type { EmbeddingProvider } from "../../core/semantic/embedding-provider.js";
import { SemanticProviderError } from "../../core/semantic/semantic-provider-error.js";

const DEFAULT_TIMEOUT_MS = 30_000;

export type OpenAICompatibleEmbeddingProviderOptions = {
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
};

type JsonObject = Record<string, unknown>;

function invalidResponse(message: string): never {
  throw new SemanticProviderError("SEMANTIC_INVALID_RESPONSE", message);
}

function dimensionMismatch(message: string): never {
  throw new SemanticProviderError("SEMANTIC_DIMENSION_MISMATCH", message);
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createOpenAICompatibleEmbeddingProvider(
  input: unknown,
  options: OpenAICompatibleEmbeddingProviderOptions = {},
): EmbeddingProvider {
  const config = parseSemanticProviderConfig(input);
  if (config.type !== "openai-compatible") {
    throw new Error("An openai-compatible semantic provider is required.");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("Semantic provider timeout must be a positive integer.");
  }

  const environment = options.env ?? process.env;
  const apiKey = config.apiKeyEnv ? environment[config.apiKeyEnv] : undefined;
  if (config.apiKeyEnv && !apiKey?.trim()) {
    throw new SemanticProviderError(
      "SEMANTIC_MISSING_ENV",
      `Environment variable ${config.apiKeyEnv} is required by the semantic provider.`,
      { env: config.apiKeyEnv },
    );
  }

  let dimensions = config.dimensions ?? 0;
  const version = createHash("sha256")
    .update(`${config.baseUrl}\n${config.model}`)
    .digest("hex")
    .slice(0, 16);

  return {
    id: "openai-compatible",
    version,
    get dimensions() { return dimensions; },
    async isAvailable() { return true; },
    async embedBatch(texts) {
      if (texts.length === 0) return [];
      let response: Response;
      try {
        response = await fetch(`${config.baseUrl}/embeddings`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(apiKey ? { authorization: `Bearer ${apiKey.trim()}` } : {}),
          },
          body: JSON.stringify({ model: config.model, input: texts }),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (cause) {
        throw new SemanticProviderError(
          "SEMANTIC_PROVIDER_UNREACHABLE",
          "Semantic provider request failed or timed out.",
          { cause },
        );
      }

      if (!response.ok) {
        if (response.status === 401 || response.status === 403) {
          throw new SemanticProviderError("SEMANTIC_AUTH_FAILED", `Semantic provider rejected authentication (HTTP ${response.status}).`);
        }
        if (response.status === 429 || response.status >= 500) {
          throw new SemanticProviderError("SEMANTIC_PROVIDER_UNREACHABLE", `Semantic provider is unavailable (HTTP ${response.status}).`);
        }
        throw new SemanticProviderError("SEMANTIC_RUNTIME_FAILED", `Semantic provider rejected the request (HTTP ${response.status}).`);
      }

      let payload: unknown;
      try {
        payload = await response.json();
      } catch (cause) {
        throw new SemanticProviderError("SEMANTIC_INVALID_RESPONSE", "Semantic provider returned malformed JSON.", { cause });
      }

      if (!isObject(payload) || !Array.isArray(payload.data) || payload.data.length !== texts.length) {
        invalidResponse(`Semantic provider returned ${isObject(payload) && Array.isArray(payload.data) ? payload.data.length : "an invalid number of"} vectors for ${texts.length} inputs.`);
      }

      const items = payload.data;
      const hasIndexes = items.some((item) => isObject(item) && item.index !== undefined);
      if (hasIndexes && items.some((item) => !isObject(item) || !Number.isSafeInteger(item.index))) {
        invalidResponse("Semantic provider returned invalid embedding indexes.");
      }
      const orderedItems = hasIndexes
        ? [...items].sort((left, right) => {
          const leftIndex = (left as JsonObject).index as number;
          const rightIndex = (right as JsonObject).index as number;
          return leftIndex - rightIndex;
        })
        : items;
      if (hasIndexes && orderedItems.some((item, index) => (item as JsonObject).index !== index)) {
        invalidResponse("Semantic provider returned duplicate or out-of-order embedding indexes.");
      }

      const vectors = orderedItems.map((item) => {
        if (!isObject(item) || !Array.isArray(item.embedding) || item.embedding.length === 0) {
          invalidResponse("Semantic provider returned an empty or malformed embedding vector.");
        }
        if (item.embedding.some((value) => typeof value !== "number" || !Number.isFinite(value))) {
          invalidResponse("Semantic provider returned non-finite embedding values.");
        }
        return item.embedding as number[];
      });
      const returnedDimensions = vectors[0]?.length ?? 0;
      if (vectors.some((vector) => vector.length !== returnedDimensions)) {
        dimensionMismatch("Semantic provider returned vectors with inconsistent dimensions.");
      }
      if (dimensions !== 0 && returnedDimensions !== dimensions) {
        dimensionMismatch(`Semantic provider returned ${returnedDimensions} dimensions; expected ${dimensions}.`);
      }
      dimensions = returnedDimensions;
      return vectors;
    },
  };
}
