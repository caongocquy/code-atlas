import type { ResolutionCoverage } from "../resolution.types.js";
import type { GraphEdge, GraphEdgeType, GraphNode } from "../types.js";

export type GraphEntityMatchReason =
  | "exact_qualified_name"
  | "exact_symbol_name"
  | "exact_normalized_token"
  | "file_path_context"
  | "prefix"
  | "lexical_relevance";

export type GraphEntityMatch = {
  entity: GraphNode;
  reason: GraphEntityMatchReason;
  score: number;
  rank: number;
};

export type GraphEntityResolution =
  | {
      status: "resolved";
      query: string;
      entity: GraphNode;
      candidates: GraphEntityMatch[];
    }
  | {
      status: "ambiguous";
      query: string;
      candidates: GraphEntityMatch[];
    }
  | {
      status: "not_found";
      query: string;
      candidates: [];
    };

export type GraphRelation = {
  entity: GraphNode;
  edge: GraphEdge;
  relation: GraphEdgeType;
  direction: "forward" | "inverse";
};

export type GraphTraversalLimits = {
  maxDepth: number;
  maxResults: number;
};

export type ImpactItem = {
  entity: GraphNode;
  relation: GraphEdgeType;
  direction: "inverse";
  depth: number;
  path: string[];
  reason: string;
  edge: GraphEdge;
};

export type ImpactResult =
  | {
      status: "resolved";
      query: string;
      target: GraphNode;
      directImpact: ImpactItem[];
      transitiveImpact: ImpactItem[];
      summary: ImpactSummary;
      risk: "low" | "medium" | "high" | "unknown";
      mayBeIncomplete: boolean;
      limits: GraphTraversalLimits;
      truncated: boolean;
    }
  | {
      status: "ambiguous" | "not_found";
      query: string;
      resolution: GraphEntityResolution;
      directImpact: [];
      transitiveImpact: [];
      mayBeIncomplete: boolean;
      limits: GraphTraversalLimits;
      truncated: false;
    };

export type ImpactSummary = {
  directCount: number;
  transitiveCount: number;
  totalCount: number;
  crossFileCount: number;
  crossDirectoryCount: number;
  relationCounts: Partial<Record<GraphEdgeType, number>>;
};

export type TraceMode = "directed" | "explanatory";

export type TraceHop = {
  from: GraphNode;
  relation: GraphEdgeType;
  direction: "forward" | "inverse";
  to: GraphNode;
  edge: GraphEdge;
};

export type TracePath = {
  nodes: GraphNode[];
  hops: TraceHop[];
};

export type TraceResult =
  | {
      status: "found";
      query: { from: string; to: string };
      source: GraphNode;
      target: GraphNode;
      path: TracePath;
      mayBeIncomplete: boolean;
      limits: { maxDepth: number; mode: TraceMode };
    }
  | {
      status: "no_path";
      query: { from: string; to: string };
      source: GraphNode;
      target: GraphNode;
      mayBeIncomplete: boolean;
      limits: { maxDepth: number; mode: TraceMode };
    }
  | {
      status: "ambiguous" | "not_found";
      query: { from: string; to: string };
      sourceResolution: GraphEntityResolution;
      targetResolution: GraphEntityResolution;
      mayBeIncomplete: boolean;
      limits: { maxDepth: number; mode: TraceMode };
    };

export function resolutionCoverageIsIncomplete(
  coverage?: Pick<ResolutionCoverage, "mayBeIncomplete">,
): boolean {
  return coverage?.mayBeIncomplete ?? false;
}
