import path from "node:path";

import type { EmbeddingProvider } from "../core/semantic/embedding-provider.js";
import type { VectorStore } from "../core/semantic/vector-store.js";
import type { RerankerProvider } from "../core/retrieval/reranker-provider.js";
import {
  canonicalRepositoryPath,
  getRepositoryIdentity,
} from "../core/repository/repository-identity.js";
import { SqliteVectorStore } from "../storage/atlas/sqlite-vector.store.js";

export type DefaultProviderSet = {
  embeddingProvider?: EmbeddingProvider;
  vectorStore: VectorStore;
  rerankerProvider?: RerankerProvider;
};

export function createDefaultProviders(repoPath: string): DefaultProviderSet {
  const absoluteRepoPath = canonicalRepositoryPath(path.resolve(repoPath));

  return {
    vectorStore: new SqliteVectorStore(
      path.join(absoluteRepoPath, ".codeatlas", "atlas.db"),
      getRepositoryIdentity(absoluteRepoPath).id,
    ),
  };
}
