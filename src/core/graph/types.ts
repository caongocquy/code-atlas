export const GRAPH_NODE_TYPES = [
  "file",
  "function",
  "class",
  "method",
  "variable",
  "interface",
  "type",
  "enum",
] as const;

export type GraphNodeType = (typeof GRAPH_NODE_TYPES)[number];

export const GRAPH_EDGE_TYPES = [
  "contains",
  "imports",
  "calls",
  "extends",
] as const;

export type GraphEdgeType = (typeof GRAPH_EDGE_TYPES)[number];

export type GraphNode = {
  id: string;
  type: GraphNodeType;
  name: string;
  qualifiedName?: string;
  file: string;
  startLine?: number;
  endLine?: number;
};

export type GraphEdge = {
  from: string;
  to: string;
  type: GraphEdgeType;
  resolutionMethod?: import("./resolution.types.js").ResolutionMethod;
  evidenceKind?: import("./resolution.types.js").ResolutionEvidenceKind;
  confidence?: number;
  resolutionSource?: import("./resolution.types.js").ResolutionLocation;
};

export type CodeGraph = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};
