import type { CodeGraph, GraphEdge, GraphNode } from "../types.js";
import type {
  CycleOptions,
  CycleRelation,
  CycleResult,
  StructuralCycle,
} from "./graph-intelligence.types.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;
const DEFAULT_RELATIONS: CycleRelation[] = ["calls", "imports", "extends"];
const relationPriority: Record<CycleRelation, number> = { calls: 0, extends: 1, implements: 1, imports: 2, references: 3 };

function nodeKey(node: GraphNode): string {
  return [node.file, node.type, node.qualifiedName ?? node.name, node.id].join(":");
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.from}:${edge.to}:${edge.type}`;
}

function clampLimit(value: number | undefined): number {
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value ?? DEFAULT_LIMIT)));
}

function sortedEdges(edges: GraphEdge[], nodeById: Map<string, GraphNode>): GraphEdge[] {
  return [...edges].sort((left, right) => {
    const leftNode = nodeById.get(left.to);
    const rightNode = nodeById.get(right.to);
    return nodeKey(leftNode ?? { id: left.to, type: "file", name: left.to, file: left.to }).localeCompare(nodeKey(rightNode ?? { id: right.to, type: "file", name: right.to, file: right.to })) || edgeKey(left).localeCompare(edgeKey(right));
  });
}

function stronglyConnectedComponents(
  nodes: GraphNode[],
  edges: GraphEdge[],
): string[][] {
  const nodeById = new Map(nodes.map((node) => [node.id, node]));
  const adjacency = new Map<string, GraphEdge[]>();
  const reverse = new Map<string, GraphEdge[]>();
  for (const edge of edges) {
    if (!nodeById.has(edge.from) || !nodeById.has(edge.to)) continue;
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge]);
    reverse.set(edge.to, [...(reverse.get(edge.to) ?? []), { ...edge, from: edge.to, to: edge.from }]);
  }
  for (const list of adjacency.values()) list.sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)));
  for (const list of reverse.values()) list.sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)));

  const visited = new Set<string>();
  const order: string[] = [];
  for (const node of [...nodes].sort((left, right) => nodeKey(left).localeCompare(nodeKey(right)))) {
    if (visited.has(node.id)) continue;
    visited.add(node.id);
    const stack: Array<{ id: string; index: number }> = [{ id: node.id, index: 0 }];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!;
      const next = adjacency.get(frame.id)?.[frame.index];
      if (next) {
        frame.index += 1;
        if (!visited.has(next.to)) {
          visited.add(next.to);
          stack.push({ id: next.to, index: 0 });
        }
      } else {
        order.push(frame.id);
        stack.pop();
      }
    }
  }

  const components: string[][] = [];
  const assigned = new Set<string>();
  for (const root of [...order].reverse()) {
    if (assigned.has(root)) continue;
    const component: string[] = [];
    const stack = [root];
    assigned.add(root);
    while (stack.length > 0) {
      const id = stack.pop()!;
      component.push(id);
      for (const edge of reverse.get(id) ?? []) {
        if (!assigned.has(edge.to)) {
          assigned.add(edge.to);
          stack.push(edge.to);
        }
      }
    }
    components.push(component.sort());
  }
  return components;
}

function findReturnPath(
  start: string,
  target: string,
  component: Set<string>,
  adjacency: Map<string, GraphEdge[]>,
  nodeById: Map<string, GraphNode>,
): GraphEdge[] | undefined {
  const queue: Array<{ id: string; path: GraphEdge[] }> = [{ id: start, path: [] }];
  const visited = new Set([start]);
  while (queue.length > 0) {
    const current = queue.shift()!;
    for (const edge of sortedEdges(adjacency.get(current.id) ?? [], nodeById)) {
      if (!component.has(edge.to)) continue;
      const path = [...current.path, edge];
      if (edge.to === target) return path;
      if (!visited.has(edge.to)) {
        visited.add(edge.to);
        queue.push({ id: edge.to, path });
      }
    }
  }
  return undefined;
}

function cycleForComponent(
  componentIds: string[],
  relation: CycleRelation,
  nodeById: Map<string, GraphNode>,
  relationEdges: GraphEdge[],
): StructuralCycle | undefined {
  const component = new Set(componentIds);
  const start = componentIds.map((id) => nodeById.get(id)).filter((node): node is GraphNode => node !== undefined).sort((left, right) => nodeKey(left).localeCompare(nodeKey(right)))[0];
  if (!start) return undefined;
  const adjacency = new Map<string, GraphEdge[]>();
  for (const edge of relationEdges) adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), edge]);
  const candidates: GraphEdge[][] = [];
  for (const edge of sortedEdges(adjacency.get(start.id) ?? [], nodeById)) {
    if (!component.has(edge.to)) continue;
    if (edge.to === start.id) candidates.push([edge]);
    else {
      const returnPath = findReturnPath(edge.to, start.id, component, adjacency, nodeById);
      if (returnPath) candidates.push([edge, ...returnPath]);
    }
  }
  const selected = candidates.sort((left, right) => left.length - right.length || left.map(edgeKey).join("|").localeCompare(right.map(edgeKey).join("|")))[0];
  if (!selected) return undefined;
  const nodes = [start, ...selected.slice(0, -1).map((edge) => nodeById.get(edge.to)).filter((node): node is GraphNode => node !== undefined)];
  return {
    relation,
    nodes,
    files: [...new Set(nodes.map((node) => node.file))].sort(),
    length: nodes.length,
    edges: selected,
  };
}

export function detectStructuralCycles(graph: CodeGraph, options: CycleOptions = {}): CycleResult {
  const limit = clampLimit(options.maxResults);
  const relations = [...new Set(options.relations ?? DEFAULT_RELATIONS)];
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const cycles: StructuralCycle[] = [];
  const counts: Partial<Record<CycleRelation, number>> = {};

  for (const relation of relations) {
    const relationEdges = graph.edges.filter((edge) => edge.type === relation);
    const relationNodeIds = new Set<string>();
    for (const edge of relationEdges) {
      relationNodeIds.add(edge.from);
      relationNodeIds.add(edge.to);
    }
    const relationNodes = graph.nodes.filter((node) => relationNodeIds.has(node.id));
    const components = stronglyConnectedComponents(relationNodes, relationEdges);
    const found = components
      .filter((component) => component.length > 1 || relationEdges.some((edge) => edge.from === component[0] && edge.to === component[0]))
      .map((component) => cycleForComponent(component, relation, nodeById, relationEdges))
      .filter((cycle): cycle is StructuralCycle => cycle !== undefined)
      .sort((left, right) => left.length - right.length || left.nodes.map(nodeKey).join("|").localeCompare(right.nodes.map(nodeKey).join("|")));
    counts[relation] = found.length;
    cycles.push(...found);
  }

  cycles.sort((left, right) => relationPriority[left.relation] - relationPriority[right.relation] || left.length - right.length || left.nodes.map(nodeKey).join("|").localeCompare(right.nodes.map(nodeKey).join("|")));
  return {
    cycles: cycles.slice(0, limit),
    counts,
    truncated: cycles.length > limit,
    mayBeIncomplete: options.coverage?.mayBeIncomplete ?? false,
  };
}
