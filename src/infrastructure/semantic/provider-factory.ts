import type { SemanticProviderConfig } from "../../core/config/codeatlas-config.js";
import type { EmbeddingProvider } from "../../core/semantic/embedding-provider.js";
import { SemanticProviderError } from "../../core/semantic/semantic-provider-error.js";
import { createOpenAICompatibleEmbeddingProvider } from "./openai-compatible-embedding-provider.js";
import {
  createTransformersLocalEmbeddingProvider,
  type TransformersLocalProviderOptions,
} from "./transformers-local-embedding-provider.js";

export function createSemanticEmbeddingProvider(
  config: SemanticProviderConfig,
  localOptions: TransformersLocalProviderOptions = {},
): EmbeddingProvider {
  if (config.type === "openai-compatible") return createOpenAICompatibleEmbeddingProvider(config);
  if (!config.revision && !localOptions.allowRemoteModels) {
    throw new SemanticProviderError("SEMANTIC_RUNTIME_FAILED", "The managed local model revision is not pinned; run semantic setup to provision it.");
  }
  return createTransformersLocalEmbeddingProvider(config, localOptions);
}
