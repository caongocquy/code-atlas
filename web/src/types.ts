export type GraphNode = {
  id: string;
  type: string;
  name: string;
  qualifiedName?: string;
  file: string;
  startLine?: number;
  endLine?: number;
};

export type GraphEdge = {
  from: string;
  to: string;
  type: "calls" | "imports" | "extends" | "contains";
};

export type GraphOverview = {
  nodes: GraphNode[];
  edges: GraphEdge[];
  totalNodes: number;
  totalEdges: number;
  truncated: boolean;
};

export type IndexedFile = {
  path: string;
  nodeId: string;
  symbols: number;
};

export type SourceResponse = {
  path: string;
  language: string;
  startLine: number;
  endLine: number;
  content: string;
};

export type Chunk = {
  key: string;
  score: number;
  file?: string;
  symbolName?: string;
  symbolType?: string;
  startLine?: number;
  endLine?: number;
  content?: string;
  source: "vector" | "lexical" | "both" | "graph";
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
  provenance: Array<{
    source: string;
    stage: string;
    relation?: string;
    depth?: number;
    seedNode?: string;
  }>;
};

export type ContextInspection = {
  chunks: Chunk[];
  dropped: Chunk[];
  tokens: number;
  budget: number;
  rendered: string;
};

export type Inspection = {
  query: string;
  repoId: string;
  options: {
    topK: number;
    rerankTopK: number;
    graphEnabled: boolean;
    graphDepth: number;
    graphMaxNodes: number;
    tokenBudget: number;
  };
  vectorResults: Chunk[];
  lexicalResults: Chunk[];
  fusedResults: Chunk[];
  rerankedResults: Chunk[];
  graphExpansion: {
    available: boolean;
    enabled: boolean;
    maxDepth: number;
    maxNodes: number;
    seedNodeIds: string[];
    nodesConsidered: number;
    nodesAdded: number;
    details: Array<{ node: Chunk; relation: string; depth: number; seedNode: string; path: string[] }>;
    error?: string;
  };
  retrievalOnly: ContextInspection;
  withGraph: ContextInspection;
  finalContext: ContextInspection;
  messages: Array<{ role: string; content: string }>;
  metrics: Record<string, number>;
  answer?: string;
  reasoningContent?: string;
};

export type Status = {
  repository: { path: string; repoId: string; sourceFiles: number };
  vector: {
    currentVersion: string;
    storedVersion?: string;
    indexedFiles: number;
    points: number;
    chunks: number;
    collection: string;
    reachable: boolean;
    status: string;
    needsSync: boolean;
    updatedAt?: string;
    error?: string;
  };
  graph: {
    currentVersion: string;
    storedVersion?: string;
    indexedFiles: number;
    nodes: number;
    edges: number;
    edgeBreakdown: Record<string, number>;
    sqlitePath: string;
    reachable: boolean;
    status: string;
    needsRebuild: boolean;
    updatedAt?: string;
  };
};

export type NodeDetails = {
  node: GraphNode;
  callers: GraphNode[];
  callees: GraphNode[];
  imports: GraphNode[];
  importedBy: GraphNode[];
  extends: GraphNode[];
  extendedBy: GraphNode[];
};
