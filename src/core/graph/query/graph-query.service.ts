import type { CodeGraph, GraphEdge, GraphEdgeType, GraphNode } from "../types.js";
import type { GraphRelation } from "./graph-query.types.js";

const relationPriority: Record<GraphEdgeType, number> = {
  calls: 0,
  extends: 1,
  imports: 2,
  contains: 3,
  implements: 1,
  references: 4,
};

function nodeKey(node: GraphNode): string {
  return [node.file, node.type, node.qualifiedName ?? node.name, node.id].join(":");
}

function relationComparator(
  left: GraphRelation,
  right: GraphRelation,
): number {
  return relationPriority[left.relation] - relationPriority[right.relation]
    || nodeKey(left.entity).localeCompare(nodeKey(right.entity))
    || left.edge.from.localeCompare(right.edge.from)
    || left.edge.to.localeCompare(right.edge.to);
}

function nodeMap(graph: CodeGraph): Map<string, GraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}

function related(
  graph: CodeGraph,
  target: GraphNode,
  predicate: (edge: GraphEdge) => boolean,
  relation: GraphEdgeType,
  direction: GraphRelation["direction"],
  maxResults = 100,
): GraphRelation[] {
  const nodes = nodeMap(graph);
  const seen = new Set<string>();

  return graph.edges
    .filter(predicate)
    .map((edge) => {
      const entityId = edge.from === target.id ? edge.to : edge.from;
      const entity = nodes.get(entityId);
      return entity ? { entity, edge, relation, direction } : undefined;
    })
    .filter((item): item is GraphRelation => item !== undefined)
    .sort(relationComparator)
    .filter((item) => {
      if (seen.has(item.entity.id)) return false;
      seen.add(item.entity.id);
      return true;
    })
    .slice(0, Math.max(0, maxResults));
}

function fileNode(graph: CodeGraph, target: GraphNode): GraphNode | undefined {
  if (target.type === "file") return target;
  return graph.nodes.find((node) => node.type === "file" && node.file === target.file);
}

export function findCallers(
  graph: CodeGraph,
  target: GraphNode,
  maxResults = 100,
): GraphRelation[] {
  return related(graph, target, (edge) => edge.type === "calls" && edge.to === target.id, "calls", "inverse", maxResults);
}

export function findCallees(
  graph: CodeGraph,
  target: GraphNode,
  maxResults = 100,
): GraphRelation[] {
  return related(graph, target, (edge) => edge.type === "calls" && edge.from === target.id, "calls", "forward", maxResults);
}

export function findImports(
  graph: CodeGraph,
  target: GraphNode,
  maxResults = 100,
): GraphRelation[] {
  const source = fileNode(graph, target);
  return source
    ? related(graph, source, (edge) => edge.type === "imports" && edge.from === source.id, "imports", "forward", maxResults)
    : [];
}

export function findImportedBy(
  graph: CodeGraph,
  target: GraphNode,
  maxResults = 100,
): GraphRelation[] {
  const source = fileNode(graph, target);
  return source
    ? related(graph, source, (edge) => edge.type === "imports" && edge.to === source.id, "imports", "inverse", maxResults)
    : [];
}
