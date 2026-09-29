import type { SearchResult } from "./code-search.service.js";
import { searchCode } from "./code-search.service.js";
import type { CapabilityState } from "../../storage/atlas/atlas.types.js";
import type { EmbeddingProvider } from "../semantic/embedding-provider.js";
import type { VectorStore } from "../semantic/vector-store.js";
import { SemanticProviderError } from "../semantic/semantic-provider-error.js";
import { getRepositoryStatusReadOnly } from "../repository/repository-status.service.js";
import {
  lexicalSearchCode,
  type LexicalSearchResult,
} from "../lexical/lexical-search.service.js";

const RRF_K = 60;

export type HybridSearchResult = SearchResult & {
  vectorScore?: number;
  lexicalScore?: number;
  fusionScore: number;
  vectorRank?: number;
  lexicalRank?: number;
};

export type HybridSearchStages = {
  vectorResults: SearchResult[];
  lexicalResults: LexicalSearchResult[];
  semanticState: CapabilityState;
  fusedResults: HybridSearchResult[];
  vectorMs: number;
  lexicalMs: number;
  searchMs: number;
};

export type HybridSearchProviders = {
  embeddingProvider?: EmbeddingProvider;
  vectorStore?: VectorStore;
  semanticState?: CapabilityState;
};

function createResultKey(result: SearchResult): string {
  return [
    result.repoId ?? "",
    result.file ?? "",
    result.symbolType ?? "",
    result.symbolName ?? "",
    result.startLine ?? "",
  ].join(":");
}

export async function hybridSearchCode(
  query: string,
  limit = 20,
  repoPath?: string,
  providers: HybridSearchProviders = {},
): Promise<HybridSearchResult[]> {
  const { fusedResults } = await inspectHybridSearch(query, limit, repoPath, providers);

  return fusedResults;
}

export async function inspectHybridSearch(
  query: string,
  limit = 20,
  repoPath?: string,
  providers: HybridSearchProviders = {},
): Promise<HybridSearchStages> {
  const searchStart = performance.now();
  let vectorMs = 0;
  let semanticState: CapabilityState = "not_configured";
  let lexicalMs = 0;

  const vectorPromise = (async () => {
    const startedAt = performance.now();

    try {
      if (!providers.embeddingProvider || !providers.vectorStore) {
        return [];
      }

      const compatibleState = providers.semanticState ?? (repoPath
        ? (await getRepositoryStatusReadOnly(repoPath, {
          embeddingProvider: providers.embeddingProvider,
          vectorStore: providers.vectorStore,
        })).capabilities.semantic.state
        : "not_configured");
      if (compatibleState !== "ready") {
        semanticState = compatibleState;
        return [];
      }

      if (!(await providers.embeddingProvider.isAvailable())) {
        semanticState = "unavailable";
        return [];
      }
      let vectorStoreAvailable: boolean;
      try {
        vectorStoreAvailable = await providers.vectorStore.isAvailable();
      } catch (cause) {
        throw new SemanticProviderError("SEMANTIC_RUNTIME_FAILED", "Semantic vector store is unavailable.", { cause });
      }
      if (!vectorStoreAvailable) {
        semanticState = "unavailable";
        return [];
      }

      const results = await searchCode(query, limit, {
        repoPath,
        embeddingProvider: providers.embeddingProvider,
        vectorStore: providers.vectorStore,
      });
      semanticState = "ready";
      return results;
    } catch (error) {
      if (!(error instanceof SemanticProviderError)) throw error;
      semanticState = "error";
      return [];
    } finally {
      vectorMs = performance.now() - startedAt;
    }
  })();

  const lexicalPromise = (async () => {
    const startedAt = performance.now();
    const results = await lexicalSearchCode(query, limit, repoPath);
    lexicalMs = performance.now() - startedAt;
    return results;
  })();

  const [vectorResults, lexicalResults] = await Promise.all([
    vectorPromise,
    lexicalPromise,
  ]);

  const fused = new Map<string, HybridSearchResult>();

  vectorResults.forEach((result, index) => {
    const key = createResultKey(result);

    const rank = index + 1;

    fused.set(key, {
      ...result,
      vectorScore: result.score,
      vectorRank: rank,
      fusionScore: 1 / (RRF_K + rank),
    });
  });

  const firstRankByLexicalGroup = new Map<string, number>();
  lexicalResults.forEach((result: LexicalSearchResult, index) => {
    const key = createResultKey(result);
    const position = index + 1;
    const rankGroup = result.lexicalRankGroup;
    const rank = rankGroup
      ? firstRankByLexicalGroup.get(rankGroup) ?? position
      : position;
    if (rankGroup && !firstRankByLexicalGroup.has(rankGroup)) firstRankByLexicalGroup.set(rankGroup, rank);

    const contribution = 1 / (RRF_K + rank);

    const existing = fused.get(key);

    if (existing) {
      existing.lexicalScore = result.lexicalScore;
      existing.lexicalRank = rank;

      existing.fusionScore += contribution;

      return;
    }

    fused.set(key, {
      ...result,
      score: 0,
      lexicalScore: result.lexicalScore,
      lexicalRank: rank,
      fusionScore: contribution,
    });
  });

  const fusedResults = Array.from(fused.values())
    .sort((a, b) => b.fusionScore - a.fusionScore)
    .slice(0, limit);

  return {
    vectorResults,
    lexicalResults,
    semanticState,
    fusedResults,
    vectorMs,
    lexicalMs,
    searchMs: performance.now() - searchStart,
  };
}
