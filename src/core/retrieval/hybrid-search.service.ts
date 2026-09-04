import type { SearchResult } from "./code-search.service.js";
import { searchCode } from "./code-search.service.js";
import type { CapabilityState } from "../../storage/atlas/atlas.types.js";
import type { EmbeddingProvider } from "../semantic/embedding-provider.js";
import type { VectorStore } from "../semantic/vector-store.js";
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

      if (
        !(await providers.embeddingProvider.isAvailable()) ||
        !(await providers.vectorStore.isAvailable())
      ) {
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
    } catch {
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

  lexicalResults.forEach((result: LexicalSearchResult, index) => {
    const key = createResultKey(result);

    const rank = index + 1;

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
