import type { CodeGraph, GraphEdge, GraphEdgeType, GraphNode } from "./types.js";

export type GraphNeighborhoodOptions = {
  depth?: number;
  maxNodes?: number;
  edgeTypes?: GraphEdgeType[];
};

export type GraphNeighborhood = {
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type GraphOverview = GraphNeighborhood & {
  totalNodes: number;
  totalEdges: number;
  truncated: boolean;
};

export type IndexedGraphFile = {
  path: string;
  nodeId: string;
  symbols: number;
};

export type GraphNodeDetails = {
  node: GraphNode;
  callers: GraphNode[];
  callees: GraphNode[];
  imports: GraphNode[];
  importedBy: GraphNode[];
  extends: GraphNode[];
  extendedBy: GraphNode[];
};

function nodeKey(node: GraphNode): string {
  return [node.file, node.type, node.qualifiedName ?? node.name, node.id].join(":");
}

function sortedNodes(nodes: GraphNode[]): GraphNode[] {
  return [...nodes].sort((a, b) => nodeKey(a).localeCompare(nodeKey(b)));
}

function createNodeMap(graph: CodeGraph): Map<string, GraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function acceptsEdge(edge: GraphEdge, edgeTypes?: Set<GraphEdgeType>): boolean {
  return !edgeTypes || edgeTypes.has(edge.type);
}

export function getGraphOverview(graph: CodeGraph, maxNodes = 2_000): GraphOverview {
  const nodes = [...graph.nodes].sort((a, b) => a.id.localeCompare(b.id)).slice(0, Math.max(1, maxNodes));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to))
    .sort((a, b) => `${a.from}:${a.to}:${a.type}`.localeCompare(`${b.from}:${b.to}:${b.type}`));

  return {
    nodes,
    edges,
    totalNodes: graph.nodes.length,
    totalEdges: graph.edges.length,
    truncated: graph.nodes.length > maxNodes,
  };
}

export function getIndexedGraphFiles(graph: CodeGraph): IndexedGraphFile[] {
  const symbolsByFile = new Map<string, number>();

  for (const node of graph.nodes) {
    if (node.type !== "file") {
      symbolsByFile.set(node.file, (symbolsByFile.get(node.file) ?? 0) + 1);
    }
  }

  return graph.nodes
    .filter((node) => node.type === "file")
    .map((node) => ({
      path: node.file,
      nodeId: node.id,
      symbols: symbolsByFile.get(node.file) ?? 0,
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function searchGraphNodes(
  graph: CodeGraph,
  query: string,
  limit = 30,
): GraphNode[] {
  const normalized = query.trim().toLowerCase();

  if (!normalized) {
    return [];
  }

  return graph.nodes
    .map((node) => {
      const name = node.name.toLowerCase();
      const qualifiedName = (node.qualifiedName ?? "").toLowerCase();
      const file = node.file.toLowerCase();
      const exact = name === normalized || qualifiedName === normalized;
      const match = exact || name.includes(normalized) || qualifiedName.includes(normalized) || file.includes(normalized);

      return {
        node,
        score: exact ? 0 : name.includes(normalized) ? 1 : 2,
        match,
      };
    })
    .filter((entry) => entry.match)
    .sort((a, b) => a.score - b.score || nodeKey(a.node).localeCompare(nodeKey(b.node)))
    .slice(0, Math.max(0, limit))
    .map((entry) => entry.node);
}

export function getGraphNodeDetails(
  graph: CodeGraph,
  nodeId: string,
): GraphNodeDetails | undefined {
  const nodeById = createNodeMap(graph);
  const node = nodeById.get(nodeId);

  if (!node) {
    return undefined;
  }

  const related = (predicate: (edge: GraphEdge) => boolean): GraphNode[] =>
    sortedNodes(
      graph.edges
        .filter(predicate)
        .map((edge) => nodeById.get(edge.to === nodeId ? edge.from : edge.to))
        .filter((candidate): candidate is GraphNode => candidate !== undefined),
    );

  return {
    node,
    callers: related((edge) => edge.type === "calls" && edge.to === nodeId),
    callees: related((edge) => edge.type === "calls" && edge.from === nodeId),
    imports: related((edge) => edge.type === "imports" && edge.from === nodeId),
    importedBy: related((edge) => edge.type === "imports" && edge.to === nodeId),
    extends: related((edge) => edge.type === "extends" && edge.from === nodeId),
    extendedBy: related((edge) => edge.type === "extends" && edge.to === nodeId),
  };
}

export function getGraphNeighborhood(
  graph: CodeGraph,
  nodeId: string,
  options: GraphNeighborhoodOptions = {},
): GraphNeighborhood {
  const depth = Math.max(0, Math.min(3, Math.floor(options.depth ?? 1)));
  const maxNodes = Math.max(1, Math.min(500, Math.floor(options.maxNodes ?? 80)));
  const edgeTypes = options.edgeTypes ? new Set(options.edgeTypes) : undefined;
  const nodeById = createNodeMap(graph);
  const seed = nodeById.get(nodeId);

  if (!seed) {
    return { nodes: [], edges: [] };
  }

  const adjacency = new Map<string, GraphEdge[]>();

  for (const edge of graph.edges) {
    if (!acceptsEdge(edge, edgeTypes)) {
      continue;
    }

    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge]);
    adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), edge]);
  }

  const visited = new Set([nodeId]);
  const queue = [{ id: nodeId, depth: 0 }];

  while (queue.length > 0 && visited.size < maxNodes) {
    const current = queue.shift();

    if (!current || current.depth >= depth) {
      continue;
    }

    const neighbors = [...(adjacency.get(current.id) ?? [])].sort((a, b) => {
      const aNode = nodeById.get(a.from === current.id ? a.to : a.from);
      const bNode = nodeById.get(b.from === current.id ? b.to : b.from);

      return nodeKey(aNode ?? seed).localeCompare(nodeKey(bNode ?? seed)) || a.type.localeCompare(b.type);
    });

    for (const edge of neighbors) {
      const neighborId = edge.from === current.id ? edge.to : edge.from;

      if (visited.has(neighborId) || !nodeById.has(neighborId)) {
        continue;
      }

      visited.add(neighborId);

      if (visited.size >= maxNodes) {
        break;
      }

      queue.push({ id: neighborId, depth: current.depth + 1 });
    }
  }

  const nodes = sortedNodes(Array.from(visited).map((id) => nodeById.get(id)).filter((node): node is GraphNode => node !== undefined));
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = graph.edges
    .filter((edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to) && acceptsEdge(edge, edgeTypes))
    .sort((a, b) => `${a.from}:${a.to}:${a.type}`.localeCompare(`${b.from}:${b.to}:${b.type}`));

  return { nodes, edges };
}

export function graphEdgeBreakdown(graph: CodeGraph): Record<GraphEdgeType, number> {
  return {
    calls: graph.edges.filter((edge) => edge.type === "calls").length,
    imports: graph.edges.filter((edge) => edge.type === "imports").length,
    extends: graph.edges.filter((edge) => edge.type === "extends").length,
    contains: graph.edges.filter((edge) => edge.type === "contains").length,
  };
}
