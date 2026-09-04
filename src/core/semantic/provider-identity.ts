import type { EmbeddingProvider } from "./embedding-provider.js";

export function embeddingProviderIdentity(provider: EmbeddingProvider): string {
  return [provider.id, provider.version, provider.dimensions].join("@");
}
