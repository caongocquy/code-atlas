import type { EmbeddingProvider } from "./embedding-provider.js";
import { SemanticProviderError } from "./semantic-provider-error.js";

const PROBE_TEXT = "CodeAtlas semantic provider probe.";

export type SemanticProviderProbe = {
  dimensions: number;
  latencyMs: number;
};

export async function probeEmbeddingProvider(provider: EmbeddingProvider): Promise<SemanticProviderProbe> {
  const startedAt = performance.now();
  try {
    const vectors = await provider.embedBatch([PROBE_TEXT]);
    const vector = vectors[0];
    if (vectors.length !== 1 || !vector?.length || vector.some((value) => !Number.isFinite(value))) {
      throw new SemanticProviderError("SEMANTIC_INVALID_RESPONSE", "Semantic provider probe returned an invalid embedding.");
    }
    if (!Number.isSafeInteger(provider.dimensions) || provider.dimensions <= 0 || vector.length !== provider.dimensions) {
      throw new SemanticProviderError("SEMANTIC_DIMENSION_MISMATCH", "Semantic provider probe returned an invalid vector dimension.");
    }
    return { dimensions: vector.length, latencyMs: performance.now() - startedAt };
  } catch (error) {
    if (error instanceof SemanticProviderError) throw error;
    throw new SemanticProviderError("SEMANTIC_RUNTIME_FAILED", "Semantic provider probe failed.", { cause: error });
  }
}
