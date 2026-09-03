import type { CodeGraph, GraphEdge, GraphNode } from "./types.js";

export type GraphQueryResult = {
  source: GraphNode;
  targets: GraphNode[];
};

function createNodeMap(graph: CodeGraph): Map<string, GraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function findEdges(
  graph: CodeGraph,
  predicate: (edge: GraphEdge) => boolean,
): GraphEdge[] {
  return graph.edges.filter(predicate);
}

function findNodesByName(graph: CodeGraph, name: string): GraphNode[] {
  return graph.nodes.filter((node) => node.name === name);
}

export function findCallers(
  graph: CodeGraph,
  symbolName: string,
): GraphQueryResult[] {
  const nodeById = createNodeMap(graph);

  const targets = findNodesByName(graph, symbolName).filter(
    (node) =>
      node.type === "function" ||
      node.type === "method" ||
      node.type === "variable",
  );

  return targets.map((target) => {
    const edges = findEdges(
      graph,
      (edge) => edge.type === "calls" && edge.to === target.id,
    );

    const callers = edges
      .map((edge) => nodeById.get(edge.from))
      .filter((node): node is GraphNode => node !== undefined);

    return {
      source: target,
      targets: callers,
    };
  });
}

export function findCallees(
  graph: CodeGraph,
  symbolName: string,
): GraphQueryResult[] {
  const nodeById = createNodeMap(graph);

  const callers = findNodesByName(graph, symbolName).filter(
    (node) => node.type === "function" || node.type === "method",
  );

  return callers.map((caller) => {
    const edges = findEdges(
      graph,
      (edge) => edge.type === "calls" && edge.from === caller.id,
    );

    const callees = edges
      .map((edge) => nodeById.get(edge.to))
      .filter((node): node is GraphNode => node !== undefined);

    return {
      source: caller,
      targets: callees,
    };
  });
}

export function findImports(
  graph: CodeGraph,
  file: string,
): GraphQueryResult[] {
  const nodeById = createNodeMap(graph);

  const source = graph.nodes.find(
    (node) => node.type === "file" && node.file === file,
  );

  if (!source) {
    return [];
  }

  const edges = findEdges(
    graph,
    (edge) => edge.type === "imports" && edge.from === source.id,
  );

  const targets = edges
    .map((edge) => nodeById.get(edge.to))
    .filter((node): node is GraphNode => node !== undefined);

  return [
    {
      source,
      targets,
    },
  ];
}

export function findImportedBy(
  graph: CodeGraph,
  file: string,
): GraphQueryResult[] {
  const nodeById = createNodeMap(graph);

  const target = graph.nodes.find(
    (node) => node.type === "file" && node.file === file,
  );

  if (!target) {
    return [];
  }

  const edges = findEdges(
    graph,
    (edge) => edge.type === "imports" && edge.to === target.id,
  );

  const sources = edges
    .map((edge) => nodeById.get(edge.from))
    .filter((node): node is GraphNode => node !== undefined);

  return [
    {
      source: target,
      targets: sources,
    },
  ];
}
