import type { CodeGraph, GraphEdge, GraphNode } from "./types.js";

export type GraphExpansionSeed = {
  file?: string;
  symbolName?: string;
  symbolType?: string;
  startLine?: number;
};

export type GraphExpansionOptions = {
  maxDepth?: number;
  maxNodes?: number;
};

export type GraphExpansionDetail = {
  node: GraphNode;
  seedNodeId: string;
  relation: GraphEdge["type"];
  depth: number;
  path: string[];
};

export type GraphExpansionResult = {
  nodes: GraphNode[];
  details: GraphExpansionDetail[];
  seedNodeIds: string[];
  nodesConsidered: number;
};

const DEFAULT_MAX_DEPTH = 2;
const DEFAULT_MAX_NODES = 8;

function nodeKey(node: GraphNode): string {
  return [node.file, node.type, node.qualifiedName ?? node.name, node.id].join(":");
}

function edgePriority(edge: GraphEdge): number {
  return edge.type === "calls" ? 0 : 1;
}

function matchesSeed(node: GraphNode, seed: GraphExpansionSeed): boolean {
  return (
    node.file === seed.file &&
    node.name === seed.symbolName &&
    node.type === seed.symbolType &&
    (seed.startLine === undefined || node.startLine === seed.startLine)
  );
}

export function expandGraphContext(
  graph: CodeGraph,
  seeds: GraphExpansionSeed[],
  options: GraphExpansionOptions = {},
): GraphNode[] {
  return expandGraphContextDetailed(graph, seeds, options).nodes;
}

export function expandGraphContextDetailed(
  graph: CodeGraph,
  seeds: GraphExpansionSeed[],
  options: GraphExpansionOptions = {},
): GraphExpansionResult {
  const maxDepth = Math.max(
    0,
    Math.floor(options.maxDepth ?? DEFAULT_MAX_DEPTH),
  );
  const maxNodes = Math.max(0, Math.floor(options.maxNodes ?? DEFAULT_MAX_NODES));
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, Array<{ edge: GraphEdge; node: GraphNode }>>();

  for (const edge of graph.edges) {
    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);

    if (!from || !to) {
      continue;
    }

    adjacency.set(edge.from, [
      ...(adjacency.get(edge.from) ?? []),
      { edge, node: to },
    ]);
    adjacency.set(edge.to, [
      ...(adjacency.get(edge.to) ?? []),
      { edge, node: from },
    ]);
  }

  for (const neighbors of adjacency.values()) {
    neighbors.sort(
      (a, b) =>
        edgePriority(a.edge) - edgePriority(b.edge) ||
        a.edge.type.localeCompare(b.edge.type) ||
        nodeKey(a.node).localeCompare(nodeKey(b.node)),
    );
  }

  const seedNodes = graph.nodes
    .filter((node) => seeds.some((seed) => matchesSeed(node, seed)))
    .sort((a, b) => nodeKey(a).localeCompare(nodeKey(b)));
  const visited = new Set(seedNodes.map((node) => node.id));
  const queue = seedNodes.map((node) => ({
    id: node.id,
    depth: 0,
    seedNodeId: node.id,
    path: [node.id],
  }));
  const added: GraphNode[] = [];
  const details: GraphExpansionDetail[] = [];
  let nodesConsidered = 0;

  while (queue.length > 0 && added.length < maxNodes) {
    const current = queue.shift();

    if (!current || current.depth >= maxDepth) {
      continue;
    }

    for (const neighbor of adjacency.get(current.id) ?? []) {
      nodesConsidered += 1;

      if (visited.has(neighbor.node.id)) {
        continue;
      }

      visited.add(neighbor.node.id);
      added.push(neighbor.node);
      details.push({
        node: neighbor.node,
        seedNodeId: current.seedNodeId,
        relation: neighbor.edge.type,
        depth: current.depth + 1,
        path: [...current.path, neighbor.node.id],
      });

      if (added.length >= maxNodes) {
        break;
      }

      queue.push({
        id: neighbor.node.id,
        depth: current.depth + 1,
        seedNodeId: current.seedNodeId,
        path: [...current.path, neighbor.node.id],
      });
    }
  }

  return {
    nodes: added,
    details,
    seedNodeIds: seedNodes.map((node) => node.id),
    nodesConsidered,
  };
}
