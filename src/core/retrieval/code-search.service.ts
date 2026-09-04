import path from "node:path";

import type { EmbeddingProvider } from "../semantic/embedding-provider.js";
import type { VectorStore } from "../semantic/vector-store.js";
import {
  canonicalRepositoryPath,
  getRepositoryIdentity,
} from "../repository/repository-identity.js";

export type SearchResult = {
  score: number;
  repoId?: string;
  file?: string;
  symbolName?: string;
  symbolType?: string;
  startLine?: number;
  endLine?: number;
  content?: string;
};

export type CodeSearchOptions = {
  repoPath?: string;
  embeddingProvider?: EmbeddingProvider;
  vectorStore?: VectorStore;
};

export async function searchCode(
  query: string,
  limit = 5,
  options: CodeSearchOptions = {},
): Promise<SearchResult[]> {
  if (!query.trim() || limit <= 0 || !options.embeddingProvider || !options.vectorStore) {
    return [];
  }

  const [queryVector] = await options.embeddingProvider.embedBatch([query]);

  if (!queryVector) {
    throw new Error("Embedding provider returned no query vector");
  }

  const repoId = options.repoPath
    ? getRepositoryIdentity(
        canonicalRepositoryPath(path.resolve(options.repoPath)),
      ).id
    : undefined;
  const results = await options.vectorStore.search(repoId, queryVector, limit);

  return results.map((point) => ({
    score: point.score,
    repoId:
      typeof point.payload?.repoId === "string"
        ? point.payload.repoId
        : undefined,
    file:
      typeof point.payload?.file === "string" ? point.payload.file : undefined,
    symbolName:
      typeof point.payload?.symbolName === "string"
        ? point.payload.symbolName
        : undefined,
    symbolType:
      typeof point.payload?.symbolType === "string"
        ? point.payload.symbolType
        : undefined,
    startLine:
      typeof point.payload?.startLine === "number"
        ? point.payload.startLine
        : undefined,
    endLine:
      typeof point.payload?.endLine === "number"
        ? point.payload.endLine
        : undefined,
    content:
      typeof point.payload?.content === "string"
        ? point.payload.content
        : undefined,
  }));
}
