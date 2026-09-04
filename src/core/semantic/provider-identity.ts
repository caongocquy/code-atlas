import type { EmbeddingProvider } from "./embedding-provider.js";
import { VECTOR_INDEX_VERSION } from "../../config/constants.js";

export function embeddingProviderIdentity(provider: EmbeddingProvider): string {
  return [provider.id, provider.version, provider.dimensions].join("@");
}

export function semanticGenerationIdentity(
  fileHash: string,
  providerIdentity: string,
  vectorStoreId: string,
  previousProviderIdentity?: string,
  hasPreviousIndex = false,
): string {
  const generation = [`v${VECTOR_INDEX_VERSION}`, fileHash, vectorStoreId];

  if (hasPreviousIndex && previousProviderIdentity !== providerIdentity) {
    generation.push(providerIdentity);
  }

  return generation.join(":");
}

export function hasVectorStoreGeneration(
  generation: string | undefined,
  vectorStoreId: string,
): boolean {
  return generation?.split(":")[2] === vectorStoreId;
}
