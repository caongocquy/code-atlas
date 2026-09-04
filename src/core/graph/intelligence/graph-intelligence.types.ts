import type { ResolutionCoverage } from "../resolution.types.js";
import type { GraphEdge, GraphEdgeType, GraphNode } from "../types.js";

export type GraphIntelligenceCoverage = Pick<ResolutionCoverage, "mayBeIncomplete">;

export type ImportanceSignals = {
  callers: number;
  callees: number;
  importedBy: number;
  dependents: number;
  crossFileReach: number;
  inheritance: number;
  normalized: {
    callers: number;
    callees: number;
    importedBy: number;
    dependents: number;
    crossFileReach: number;
    inheritance: number;
  };
  kindWeight: number;
  noisePenalty: number;
  suppressionReasons: string[];
};

export type ImportantSymbol = {
  symbol: GraphNode;
  score: number;
  rank: number;
  signals: ImportanceSignals;
};

export type ImportanceOptions = {
  limit?: number;
  includeFiles?: boolean;
  coverage?: GraphIntelligenceCoverage;
};

export type ImportanceResult = {
  items: ImportantSymbol[];
  totalCandidates: number;
  truncated: boolean;
  normalization: "log1p-max";
  mayBeIncomplete: boolean;
};

export type CommunityQuality = "normal" | "tiny" | "singleton" | "oversized";

export type GraphCommunity = {
  id: string;
  label: string;
  size: number;
  memberIds: string[];
  representatives: GraphNode[];
  files: string[];
  directories: string[];
  internalEdgeCount: number;
  externalEdgeCount: number;
  cohesion: number;
  coupling: number;
  quality: CommunityQuality;
};

export type CommunityCoupling = {
  sourceCommunityId: string;
  targetCommunityId: string;
  edgeCount: number;
  relationCounts: Partial<Record<GraphEdgeType, number>>;
  representativeEdges: GraphEdge[];
  representativeSymbols: GraphNode[];
};

export type CommunityOptions = {
  maxResults?: number;
  maxCommunitySize?: number;
  includeSingletons?: boolean;
  coverage?: GraphIntelligenceCoverage;
};

export type CommunityResult = {
  communities: GraphCommunity[];
  membership: Record<string, string>;
  coupling: CommunityCoupling[];
  totalCommunities: number;
  largestCommunitySize: number;
  crossCommunityEdgeCount: number;
  truncated: boolean;
  mayBeIncomplete: boolean;
};

export type BridgeOptions = {
  limit?: number;
  coverage?: GraphIntelligenceCoverage;
};

export type ArchitecturalBridge = {
  edge: GraphEdge;
  source: GraphNode;
  target: GraphNode;
  sourceCommunityId: string;
  targetCommunityId: string;
  score: number;
  reason: string;
};

export type BridgeResult = {
  bridges: ArchitecturalBridge[];
  coupling: CommunityCoupling[];
  totalCandidates: number;
  truncated: boolean;
  mayBeIncomplete: boolean;
};

export type CycleRelation = Exclude<GraphEdgeType, "contains">;

export type StructuralCycle = {
  relation: CycleRelation;
  nodes: GraphNode[];
  files: string[];
  length: number;
  edges: GraphEdge[];
};

export type CycleOptions = {
  maxResults?: number;
  relations?: CycleRelation[];
  coverage?: GraphIntelligenceCoverage;
};

export type CycleResult = {
  cycles: StructuralCycle[];
  counts: Partial<Record<CycleRelation, number>>;
  truncated: boolean;
  mayBeIncomplete: boolean;
};

export type GraphIntelligenceOptions = {
  coverage?: GraphIntelligenceCoverage;
  importance?: Omit<ImportanceOptions, "coverage">;
  communities?: Omit<CommunityOptions, "coverage">;
  bridges?: Omit<BridgeOptions, "coverage">;
  cycles?: Omit<CycleOptions, "coverage">;
};

export type GraphIntelligenceResult = {
  importance: ImportanceResult;
  communities: CommunityResult;
  bridges: BridgeResult;
  cycles: CycleResult;
  mayBeIncomplete: boolean;
};
