import fs from "node:fs/promises";
import path from "node:path";

import {
  expandGraphContextDetailed,
  type GraphExpansionDetail,
} from "../graph/expand.js";
import { GraphStore } from "../graph/store.js";
import type { GraphNode } from "../graph/types.js";
import { chatStream, type StreamChatOptions } from "../lib/llama.js";
import { rerank } from "../lib/reranker.js";
import type { SearchResult } from "./code-search.js";
import {
  inspectHybridSearch,
  type HybridSearchResult,
} from "./hybrid-search.js";
import { applyContextBudgetDetailed } from "../utils/context-budget.js";
import type { DetailedContextBudgetResult } from "../utils/context-budget.js";
import { buildContext } from "../utils/context.js";
import { buildCodebaseMessages } from "../utils/prompt.js";
import { getRepoId } from "../utils/repo.js";

export type RetrievalInspectOptions = {
  topK?: number;
  rerankTopK?: number;
  graphEnabled?: boolean;
  graphDepth?: number;
  graphMaxNodes?: number;
  tokenBudget?: number;
  repoPath?: string;
};

export type AnswerCodebaseOptions = RetrievalInspectOptions & {
  onInspection?: (inspection: RetrievalInspection) => void | Promise<void>;
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
  messages: ReturnType<typeof buildCodebaseMessages>;
  metrics: {
    vectorMs: number;
    lexicalMs: number;
    searchMs: number;
    rerankMs: number;
    graphExpansionMs: number;
    contextMs: number;
    totalMs: number;
  };
};

export type AnswerInspection = RetrievalInspection & {
  answer: string;
  reasoningContent: string;
  metrics: RetrievalInspection["metrics"] & {
    ttftMs: number | null;
    generationMs: number;
    totalMs: number;
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
  const repoPath = path.resolve(inputOptions.repoPath ?? process.cwd());
  const repoId = getRepoId(repoPath);
  const stages = await inspectHybridSearch(trimmedQuery, options.topK);
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
  const reranked = await rerank(trimmedQuery, stages.fusedResults, options.rerankTopK);
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
  const graphPath = path.join(repoPath, ".code-rag", "graph.db");
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
    await fs.access(graphPath);

    if (options.graphEnabled && options.graphMaxNodes > 0) {
      const graphStore = new GraphStore(graphPath);

      try {
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
  const retrievalOnly = inspectBudget(
    applyContextBudgetDetailed(rerankedResults, options.tokenBudget),
  );
  const withGraph = inspectBudget(
    applyContextBudgetDetailed(
      mergeChunks(rerankedResults, graphChunks),
      options.tokenBudget,
    ),
  );
  const finalContext = options.graphEnabled ? withGraph : retrievalOnly;
  const contextMs = performance.now() - contextStart;
  const messages = buildCodebaseMessages(trimmedQuery, finalContext.rendered);

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
    messages,
    metrics: {
      vectorMs: stages.vectorMs,
      lexicalMs: stages.lexicalMs,
      searchMs: stages.searchMs,
      rerankMs,
      graphExpansionMs,
      contextMs,
      totalMs: stages.searchMs + rerankMs + graphExpansionMs + contextMs,
    },
  };
}

export async function answerCodebase(
  query: string,
  options: AnswerCodebaseOptions = {},
  streamOptions: StreamChatOptions = {},
): Promise<AnswerInspection> {
  const { onInspection, ...inspectOptions } = options;
  const inspection = await inspectRetrieval(query, inspectOptions);
  await onInspection?.(inspection);
  const answerStart = performance.now();
  const result = await chatStream(inspection.messages, streamOptions);
  const totalMs = performance.now() - answerStart;

  return {
    ...inspection,
    answer: result.content,
    reasoningContent: result.reasoningContent,
    metrics: {
      ...inspection.metrics,
      ttftMs: result.ttftMs,
      generationMs: result.totalMs,
      totalMs: inspection.metrics.totalMs + totalMs,
    },
  };
}
