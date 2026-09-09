import type { ResolutionCoverage } from "../resolution.types.js";
import type { CodeGraph, GraphEdge, GraphEdgeType, GraphNode } from "../types.js";
import { GraphQueryEntityResolver } from "./graph-query-entity-resolver.js";
import type { TraceHop, TraceMode, TracePath, TraceResult } from "./graph-query.types.js";
import { resolutionCoverageIsIncomplete } from "./graph-query.types.js";

const DEFAULT_MAX_DEPTH = 8;
const MAX_DEPTH = 32;
const defaultRelations: GraphEdgeType[] = ["calls", "extends", "implements", "references", "imports"];
const relationPriority: Record<GraphEdgeType, number> = { calls: 0, extends: 1, implements: 1, references: 2, imports: 3, contains: 4 };

function nodeKey(node: GraphNode): string {
  return [node.file, node.type, node.qualifiedName ?? node.name, node.id].join(":");
}

function clampDepth(value: number | undefined): number {
  return Math.max(0, Math.min(MAX_DEPTH, Math.floor(value ?? DEFAULT_MAX_DEPTH)));
}

type TraversalStep = {
  from: string;
  to: string;
  edge: GraphEdge;
  direction: "forward" | "inverse";
};

function stepComparator(nodeById: Map<string, GraphNode>, left: TraversalStep, right: TraversalStep): number {
  const leftNode = nodeById.get(left.to);
  const rightNode = nodeById.get(right.to);
  return relationPriority[left.edge.type] - relationPriority[right.edge.type]
    || nodeKey(leftNode ?? { id: left.to, type: "file", name: left.to, file: left.to }).localeCompare(nodeKey(rightNode ?? { id: right.to, type: "file", name: right.to, file: right.to }))
    || left.direction.localeCompare(right.direction)
    || left.edge.from.localeCompare(right.edge.from)
    || left.edge.to.localeCompare(right.edge.to);
}

function buildAdjacency(
  graph: CodeGraph,
  mode: TraceMode,
  relations: GraphEdgeType[],
): Map<string, TraversalStep[]> {
  const allowed = new Set(relations);
  const adjacency = new Map<string, TraversalStep[]>();

  for (const edge of graph.edges) {
    if (!allowed.has(edge.type)) continue;
    adjacency.set(edge.from, [...(adjacency.get(edge.from) ?? []), { from: edge.from, to: edge.to, edge, direction: "forward" }]);
    if (mode === "explanatory") {
      adjacency.set(edge.to, [...(adjacency.get(edge.to) ?? []), { from: edge.to, to: edge.from, edge, direction: "inverse" }]);
    }
  }

  return adjacency;
}

function pathFromSteps(
  source: GraphNode,
  nodeById: Map<string, GraphNode>,
  steps: TraversalStep[],
): TracePath {
  const nodes = [source];
  const hops: TraceHop[] = [];

  for (const step of steps) {
    const from = nodeById.get(step.from);
    const to = nodeById.get(step.to);
    if (!from || !to) continue;
    nodes.push(to);
    hops.push({ from, relation: step.edge.type, direction: step.direction, to, edge: step.edge });
  }

  return { nodes, hops };
}

function findPath(
  graph: CodeGraph,
  source: GraphNode,
  target: GraphNode,
  maxDepth: number,
  mode: TraceMode,
  relations: GraphEdgeType[],
): TracePath | undefined {
  if (source.id === target.id) return { nodes: [source], hops: [] };
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const adjacency = buildAdjacency(graph, mode, relations);
  const queue: Array<{ nodeId: string; steps: TraversalStep[] }> = [{ nodeId: source.id, steps: [] }];
  const visited = new Set([source.id]);

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.steps.length >= maxDepth) continue;

    const nextSteps = [...(adjacency.get(current.nodeId) ?? [])].sort((left, right) => stepComparator(nodeById, left, right));
    for (const step of nextSteps) {
      if (visited.has(step.to) || !nodeById.has(step.to)) continue;
      const steps = [...current.steps, step];
      if (step.to === target.id) return pathFromSteps(source, nodeById, steps);
      visited.add(step.to);
      queue.push({ nodeId: step.to, steps });
    }
  }

  return undefined;
}

function unresolvedResult(
  from: string,
  to: string,
  sourceResolution: ReturnType<GraphQueryEntityResolver["resolve"]>,
  targetResolution: ReturnType<GraphQueryEntityResolver["resolve"]>,
  maxDepth: number,
  mode: TraceMode,
  mayBeIncomplete: boolean,
): TraceResult {
  return {
    status: sourceResolution.status === "not_found" || targetResolution.status === "not_found" ? "not_found" : "ambiguous",
    query: { from, to },
    sourceResolution,
    targetResolution,
    mayBeIncomplete,
    limits: { maxDepth, mode },
  };
}

export function traceGraph(
  graph: CodeGraph,
  from: string,
  to: string,
  options: { maxDepth?: number; mode?: TraceMode; relations?: GraphEdgeType[]; coverage?: Pick<ResolutionCoverage, "mayBeIncomplete"> } = {},
): TraceResult {
  const maxDepth = clampDepth(options.maxDepth);
  const mode = options.mode ?? "directed";
  const mayBeIncomplete = resolutionCoverageIsIncomplete(options.coverage);
  const resolver = new GraphQueryEntityResolver(graph);
  const sourceResolution = resolver.resolve(from);
  const targetResolution = resolver.resolve(to);

  if (sourceResolution.status !== "resolved" || targetResolution.status !== "resolved") {
    return unresolvedResult(from, to, sourceResolution, targetResolution, maxDepth, mode, mayBeIncomplete);
  }

  const source = sourceResolution.entity;
  const target = targetResolution.entity;
  const path = findPath(graph, source, target, maxDepth, mode, options.relations ?? defaultRelations);

  return path
    ? { status: "found", query: { from, to }, source, target, path, mayBeIncomplete, limits: { maxDepth, mode } }
    : { status: "no_path", query: { from, to }, source, target, mayBeIncomplete, limits: { maxDepth, mode } };
}
