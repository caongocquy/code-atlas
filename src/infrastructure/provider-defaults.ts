import type { EmbeddingProvider } from "../core/semantic/embedding-provider.js";
import type { VectorStore } from "../core/semantic/vector-store.js";
import type { RerankerProvider } from "../core/retrieval/reranker-provider.js";
import { transformersEmbeddingProvider } from "./embedding/transformers-embedding.client.js";
import { transformersRerankerProvider } from "./reranker/transformers-reranker.client.js";
import { qdrantVectorStore } from "./vector/qdrant-vector.store.js";

export type DefaultProviderSet = {
  embeddingProvider: EmbeddingProvider;
  vectorStore: VectorStore;
  rerankerProvider: RerankerProvider;
};

export const defaultProviders: DefaultProviderSet = {
  embeddingProvider: transformersEmbeddingProvider,
  vectorStore: qdrantVectorStore,
  rerankerProvider: transformersRerankerProvider,
};
