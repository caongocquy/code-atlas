import { SemanticProviderError as SemanticProviderErrorClass } from "../../core/semantic/semantic-provider-error.js";
import { createDefaultProviders, type DefaultProviderSet } from "../provider-defaults.js";
import { readRepositoryConfig } from "./semantic-config.store.js";
import { createSemanticEmbeddingProvider } from "./provider-factory.js";

export async function createConfiguredProviders(
  repoPath: string,
  options: { readOnly?: boolean } = {},
): Promise<DefaultProviderSet> {
  const config = await readRepositoryConfig(repoPath);
  const providers = createDefaultProviders(repoPath, options);
  if (!config.semantic?.enabled) return providers;
  try {
    providers.embeddingProvider = createSemanticEmbeddingProvider(config.semantic.provider);
  } catch (error) {
    if (error instanceof SemanticProviderErrorClass) {
      providers.embeddingProvider = {
        id: config.semantic.provider.type,
        version: error.code,
        dimensions: config.semantic.provider.dimensions ?? 1,
        async isAvailable() { throw error; },
        async embedBatch() { throw error; },
      };
      return providers;
    }
    throw error;
  }
  return providers;
}

export function closeConfiguredProviders(providers: DefaultProviderSet | undefined): void {
  if (providers && "close" in providers.vectorStore && typeof providers.vectorStore.close === "function") {
    providers.vectorStore.close();
  }
}
