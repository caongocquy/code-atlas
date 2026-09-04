import fs from "node:fs/promises";
import path from "node:path";

import {
  expandGraphContextDetailed,
  type GraphExpansionDetail,
} from "../graph/expand.js";
import { AtlasStore } from "../../storage/atlas/atlas.store.js";
import type { GraphNode } from "../graph/types.js";
import type { SearchResult } from "./code-search.service.js";
import {
  inspectHybridSearch,
  type HybridSearchProviders,
  type HybridSearchResult,
} from "./hybrid-search.service.js";
import type { RerankerProvider } from "./reranker-provider.js";
import type { CapabilityState } from "../../storage/atlas/atlas.types.js";
import { applyContextBudgetDetailed } from "./context-budget.js";
import type { DetailedContextBudgetResult, TokenCounter } from "./context-budget.js";
import { buildContext } from "./context.js";
import { getRepositoryIdentity } from "../repository/repository-identity.js";

export type RetrievalInspectOptions = {
  topK?: number;
  rerankTopK?: number;
  graphEnabled?: boolean;
  graphDepth?: number;
  graphMaxNodes?: number;
  tokenBudget?: number;
  repoPath?: string;
  providers?: RetrievalProviders;
};

export type RetrievalProviders = HybridSearchProviders & {
  rerankerProvider?: RerankerProvider;
};

export type ChunkProvenance = {
  source: "vector" | "lexical" | "both" | "graph";
  stage: "vector" | "lexical" | "fusion" | "rerank" | "graph";
  relation?: string;
  depth?: number;
  seedNode?: string;
};

export type InspectorChunk = SearchResult & {
  key: string;
  source: ChunkProvenance["source"];
  vectorScore?: number;
  lexicalScore?: number;
  fusionScore?: number;
  rerankScore?: number;
  vectorRank?: number;
  lexicalRank?: number;
  fusionRank?: number;
  rerankRank?: number;
  rankBefore?: number;
  tokens?: number;
  included?: boolean;
  provenance: ChunkProvenance[];
};

export type GraphExpansionInspection = {
  available: boolean;
  enabled: boolean;
  maxDepth: number;
  maxNodes: number;
  seedNodeIds: string[];
  nodesConsidered: number;
  nodesAdded: number;
  details: Array<{
    node: InspectorChunk;
    relation: string;
    depth: number;
    seedNode: string;
    path: string[];
  }>;
  error?: string;
};

export type ContextInspection = {
  chunks: InspectorChunk[];
  dropped: InspectorChunk[];
  tokens: number;
  budget: number;
  rendered: string;
};

export type RetrievalInspection = {
  query: string;
  repoId: string;
  options: Required<
    Pick<
      RetrievalInspectOptions,
      "topK" | "rerankTopK" | "graphEnabled" | "graphDepth" | "graphMaxNodes" | "tokenBudget"
    >
  >;
  vectorResults: InspectorChunk[];
  lexicalResults: InspectorChunk[];
  fusedResults: InspectorChunk[];
  rerankedResults: InspectorChunk[];
  graphExpansion: GraphExpansionInspection;
  retrievalOnly: ContextInspection;
  withGraph: ContextInspection;
  finalContext: ContextInspection;
  metrics: {
    vectorMs: number;
    lexicalMs: number;
    searchMs: number;
    rerankMs: number;
    graphExpansionMs: number;
    contextMs: number;
    totalMs: number;
  };
  capabilities: {
    semantic: CapabilityState;
    reranker: CapabilityState;
  };
};

const DEFAULT_OPTIONS = {
  topK: 20,
  rerankTopK: 5,
  graphEnabled: true,
  graphDepth: 2,
  graphMaxNodes: 8,
  tokenBudget: 4_000,
} as const;

function resultKey(result: SearchResult): string {
  return [
    result.repoId ?? "",
    result.file ?? "",
    result.symbolType ?? "",
    result.symbolName ?? "",
    result.startLine ?? "",
  ].join(":");
}

function normalizeOptions(options: RetrievalInspectOptions): RetrievalInspection["options"] {
  return {
    topK: Math.max(1, Math.min(50, Math.floor(options.topK ?? DEFAULT_OPTIONS.topK))),
    rerankTopK: Math.max(1, Math.min(20, Math.floor(options.rerankTopK ?? DEFAULT_OPTIONS.rerankTopK))),
    graphEnabled: options.graphEnabled ?? DEFAULT_OPTIONS.graphEnabled,
    graphDepth: Math.max(0, Math.min(3, Math.floor(options.graphDepth ?? DEFAULT_OPTIONS.graphDepth))),
    graphMaxNodes: Math.max(0, Math.min(100, Math.floor(options.graphMaxNodes ?? DEFAULT_OPTIONS.graphMaxNodes))),
    tokenBudget: Math.max(100, Math.min(20_000, Math.floor(options.tokenBudget ?? DEFAULT_OPTIONS.tokenBudget))),
  };
}

function sourceFor(
  result: SearchResult & {
    vectorScore?: number;
    lexicalScore?: number;
  },
): ChunkProvenance["source"] {
  return result.vectorScore !== undefined && result.lexicalScore !== undefined
    ? "both"
    : result.vectorScore !== undefined
      ? "vector"
      : "lexical";
}

function toInspectorChunk(
  result: SearchResult,
  provenance: ChunkProvenance[],
  extra: Partial<InspectorChunk> = {},
): InspectorChunk {
  return {
    ...result,
    key: resultKey(result),
    source: sourceFor(result),
    provenance,
    ...extra,
  };
}

function stageChunk(
  result: HybridSearchResult,
  stage: ChunkProvenance["stage"],
  rank?: number,
): InspectorChunk {
  const source = sourceFor(result);

  return toInspectorChunk(result, [
    {
      source,
      stage,
    },
  ], {
    vectorScore: result.vectorScore,
    lexicalScore: result.lexicalScore,
    fusionScore: result.fusionScore,
    vectorRank: result.vectorRank,
    lexicalRank: result.lexicalRank,
    fusionRank: rank,
  });
}

async function graphNodeToChunk(
  node: GraphNode,
  repoPath: string,
  detail: GraphExpansionDetail,
): Promise<InspectorChunk> {
  let content = "";

  if (node.startLine !== undefined && node.endLine !== undefined) {
    const source = await fs.readFile(path.join(repoPath, node.file), "utf8");
    content = source.split(/\r?\n/).slice(node.startLine - 1, node.endLine).join("\n");
  }

  const result: SearchResult = {
    score: 0,
    file: node.file,
    symbolName: node.name,
    symbolType: node.type,
    startLine: node.startLine,
    endLine: node.endLine,
    content,
  };

  return toInspectorChunk(result, [{
    source: "graph",
    stage: "graph",
    relation: detail.relation,
    depth: detail.depth,
    seedNode: detail.seedNodeId,
  }], {
    source: "graph",
  });
}

function inspectBudget(
  result: DetailedContextBudgetResult,
): ContextInspection {
  const withDecision = (decision: DetailedContextBudgetResult["decisions"][number]): InspectorChunk => {
    const chunk = decision.chunk as InspectorChunk;

    return {
      ...chunk,
      tokens: decision.tokens,
      included: decision.included,
    };
  };
  const chunks = result.decisions.filter((decision) => decision.included).map(withDecision);
  const dropped = result.decisions.filter((decision) => !decision.included).map(withDecision);

  return {
    chunks,
    dropped,
    tokens: result.usedTokens,
    budget: result.budget,
    rendered: buildContext(result.chunks),
  };
}

function mergeChunks(
  primary: InspectorChunk[],
  graphChunks: InspectorChunk[],
): InspectorChunk[] {
  const merged = new Map<string, InspectorChunk>();

  for (const chunk of [...primary, ...graphChunks]) {
    const existing = merged.get(chunk.key);

    if (!existing) {
      merged.set(chunk.key, chunk);
      continue;
    }

    merged.set(chunk.key, {
      ...existing,
      source: existing.source === "graph" ? chunk.source : existing.source,
      provenance: [...existing.provenance, ...chunk.provenance],
    });
  }

  return Array.from(merged.values());
}

export async function inspectRetrieval(
  query: string,
  inputOptions: RetrievalInspectOptions = {},
): Promise<RetrievalInspection> {
  const trimmedQuery = query.trim();

  if (!trimmedQuery) {
    throw new Error("Query must not be empty");
  }

  const options = normalizeOptions(inputOptions);
  const providers = inputOptions.providers;
  const repoPath = path.resolve(inputOptions.repoPath ?? process.cwd());
  let repoId = getRepositoryIdentity(repoPath).id;
  const stages = await inspectHybridSearch(
    trimmedQuery,
    options.topK,
    repoPath,
    providers,
  );
  const vectorResults = stages.vectorResults.map((result, index) =>
    toInspectorChunk(result, [{ source: "vector", stage: "vector" }], {
      source: "vector",
      vectorScore: result.score,
      vectorRank: index + 1,
    }),
  );
  const lexicalResults = stages.lexicalResults.map((result, index) =>
    toInspectorChunk(result, [{ source: "lexical", stage: "lexical" }], {
      source: "lexical",
      lexicalScore: result.lexicalScore,
      lexicalRank: index + 1,
    }),
  );
  const fusedResults = stages.fusedResults.map((result, index) =>
    stageChunk(result, "fusion", index + 1),
  );

  const rerankStart = performance.now();
  let rerankerState: CapabilityState = "not_configured";
  let reranked: Array<HybridSearchResult & { rerankScore?: number }> = stages.fusedResults;
  const rerankerProvider = providers?.rerankerProvider;

  if (rerankerProvider) {
    try {
      if (await rerankerProvider.isAvailable()) {
        reranked = await rerankerProvider.rerank(
          trimmedQuery,
          stages.fusedResults,
          options.rerankTopK,
        );
        rerankerState = "ready";
      } else {
        rerankerState = "unavailable";
      }
    } catch {
      rerankerState = "error";
    }
  }
  const rerankMs = performance.now() - rerankStart;
  const rerankedResults = reranked.map((result, index) => {
    const before = fusedResults.findIndex((candidate) => candidate.key === resultKey(result));

    return toInspectorChunk(result, [{ source: sourceFor(result), stage: "rerank" }], {
      vectorScore: result.vectorScore,
      lexicalScore: result.lexicalScore,
      fusionScore: result.fusionScore,
      rerankScore: result.rerankScore,
      vectorRank: result.vectorRank,
      lexicalRank: result.lexicalRank,
      fusionRank: before >= 0 ? before + 1 : undefined,
      rerankRank: index + 1,
      rankBefore: before >= 0 ? before + 1 : undefined,
    });
  });

  const graphStart = performance.now();
  let graphExpansion: GraphExpansionInspection = {
    available: false,
    enabled: options.graphEnabled,
    maxDepth: options.graphDepth,
    maxNodes: options.graphMaxNodes,
    seedNodeIds: [],
    nodesConsidered: 0,
    nodesAdded: 0,
    details: [],
  };
  let graphChunks: InspectorChunk[] = [];

  try {
    if (options.graphEnabled && options.graphMaxNodes > 0) {
      const graphStore = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));

      try {
        repoId = graphStore.ensureRepository(getRepositoryIdentity(repoPath)).id;
        if (graphStore.getFileStates(repoId).size === 0) {
          throw new Error(`No persisted graph found for repo "${repoId}".`);
        }
        const graph = graphStore.loadGraph(repoId);
        const expansion = expandGraphContextDetailed(
          graph,
          rerankedResults.map((result) => result),
          {
            maxDepth: options.graphDepth,
            maxNodes: options.graphMaxNodes,
          },
        );

        graphChunks = await Promise.all(
          expansion.details.map((detail) => graphNodeToChunk(detail.node, repoPath, detail)),
        );
        graphExpansion = {
          ...graphExpansion,
          available: true,
          seedNodeIds: expansion.seedNodeIds,
          nodesConsidered: expansion.nodesConsidered,
          nodesAdded: graphChunks.length,
          details: expansion.details.map((detail, index) => ({
            node: graphChunks[index]!,
            relation: detail.relation,
            depth: detail.depth,
            seedNode: detail.seedNodeId,
            path: detail.path,
          })),
        };
      } finally {
        graphStore.close();
      }
    } else {
      graphExpansion = {
        ...graphExpansion,
        available: true,
      };
    }
  } catch (error) {
    graphExpansion = {
      ...graphExpansion,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  const graphExpansionMs = performance.now() - graphStart;
  const contextStart = performance.now();
  const tokenCounter: TokenCounter | undefined =
    stages.semanticState === "ready"
      ? inputOptions.providers?.embeddingProvider?.countTokens
      : undefined;
  const retrievalOnly = inspectBudget(
    await applyContextBudgetDetailed(rerankedResults, options.tokenBudget, tokenCounter),
  );
  const withGraph = inspectBudget(
    await applyContextBudgetDetailed(
      mergeChunks(rerankedResults, graphChunks),
      options.tokenBudget,
      tokenCounter,
    ),
  );
  const finalContext = options.graphEnabled ? withGraph : retrievalOnly;
  const contextMs = performance.now() - contextStart;

  return {
    query: trimmedQuery,
    repoId,
    options,
    vectorResults,
    lexicalResults,
    fusedResults,
    rerankedResults,
    graphExpansion,
    retrievalOnly,
    withGraph,
    finalContext,
    metrics: {
      vectorMs: stages.vectorMs,
      lexicalMs: stages.lexicalMs,
      searchMs: stages.searchMs,
      rerankMs,
      graphExpansionMs,
      contextMs,
      totalMs: stages.searchMs + rerankMs + graphExpansionMs + contextMs,
    },
    capabilities: {
      semantic: stages.semanticState,
      reranker: rerankerState,
    },
  };
}
