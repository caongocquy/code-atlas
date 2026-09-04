import type { ResolutionCoverage } from "../resolution.types.js";
import type { CodeGraph, GraphEdge, GraphEdgeType, GraphNode } from "../types.js";
import { GraphQueryEntityResolver } from "./graph-query-entity-resolver.js";
import type {
  GraphEntityResolution,
  GraphTraversalLimits,
  ImpactItem,
  ImpactResult,
  ImpactSummary,
} from "./graph-query.types.js";
import { resolutionCoverageIsIncomplete } from "./graph-query.types.js";

const DEFAULT_MAX_DEPTH = 3;
const DEFAULT_MAX_RESULTS = 100;
const MAX_DEPTH = 10;
const MAX_RESULTS = 1_000;
const impactRelations: GraphEdgeType[] = ["calls", "imports", "extends"];
const relationPriority: Record<GraphEdgeType, number> = { calls: 0, extends: 1, imports: 2, contains: 3 };

function clamp(value: number | undefined, fallback: number, maximum: number): number {
  return Math.max(0, Math.min(maximum, Math.floor(value ?? fallback)));
}

function nodeKey(node: GraphNode): string {
  return [node.file, node.type, node.qualifiedName ?? node.name, node.id].join(":");
}

function edgeComparator(
  nodeById: Map<string, GraphNode>,
  left: GraphEdge,
  right: GraphEdge,
): number {
  const leftNode = nodeById.get(left.from);
  const rightNode = nodeById.get(right.from);
  return relationPriority[left.type] - relationPriority[right.type]
    || nodeKey(leftNode ?? { id: left.from, type: "file", name: left.from, file: left.from }).localeCompare(nodeKey(rightNode ?? { id: right.from, type: "file", name: right.from, file: right.from }))
    || left.from.localeCompare(right.from)
    || left.to.localeCompare(right.to);
}

function impactReason(type: GraphEdgeType): string {
  return type === "calls"
    ? "caller"
    : type === "imports"
      ? "imported-by"
      : type === "extends"
        ? "inheritance-dependent"
        : "dependent";
}

function targetNodes(graph: CodeGraph, target: GraphNode): GraphNode[] {
  if (target.type !== "file") return [target];
  return graph.nodes.filter((node) => node.file === target.file).sort((left, right) => nodeKey(left).localeCompare(nodeKey(right)));
}

function summarize(items: ImpactItem[], target: GraphNode): ImpactSummary {
  const relationCounts: Partial<Record<GraphEdgeType, number>> = {};
  const files = new Set<string>();
  const directories = new Set<string>();

  for (const item of items) {
    relationCounts[item.relation] = (relationCounts[item.relation] ?? 0) + 1;
    files.add(item.entity.file);
    directories.add(item.entity.file.split("/").slice(0, -1).join("/"));
  }

  const directCount = items.filter((item) => item.depth === 1).length;
  const transitiveCount = items.length - directCount;
  const crossFileCount = items.filter((item) => item.entity.file !== target.file).length;
  const targetDirectory = target.file.split("/").slice(0, -1).join("/");

  return {
    directCount,
    transitiveCount,
    totalCount: items.length,
    crossFileCount,
    crossDirectoryCount: Array.from(directories).filter((directory) => directory !== targetDirectory).length,
    relationCounts,
  };
}

function riskFor(summary: ImpactSummary, mayBeIncomplete: boolean): "low" | "medium" | "high" | "unknown" {
  if (mayBeIncomplete) return "unknown";
  if (summary.directCount >= 10 || summary.totalCount >= 50 || summary.crossDirectoryCount >= 5) return "high";
  if (summary.directCount >= 3 || summary.totalCount >= 10 || summary.crossFileCount >= 3) return "medium";
  return "low";
}

function emptyResult(
  query: string,
  resolution: GraphEntityResolution,
  limits: GraphTraversalLimits,
  mayBeIncomplete: boolean,
): ImpactResult {
  return {
    status: resolution.status === "ambiguous" ? "ambiguous" : "not_found",
    query,
    resolution,
    directImpact: [],
    transitiveImpact: [],
    mayBeIncomplete,
    limits,
    truncated: false,
  };
}

export function analyzeImpact(
  graph: CodeGraph,
  query: string,
  options: { maxDepth?: number; maxResults?: number; coverage?: Pick<ResolutionCoverage, "mayBeIncomplete"> } = {},
): ImpactResult {
  const limits = {
    maxDepth: clamp(options.maxDepth, DEFAULT_MAX_DEPTH, MAX_DEPTH),
    maxResults: clamp(options.maxResults, DEFAULT_MAX_RESULTS, MAX_RESULTS),
  };
  const resolution = new GraphQueryEntityResolver(graph).resolve(query);
  const mayBeIncomplete = resolutionCoverageIsIncomplete(options.coverage);

  if (resolution.status !== "resolved") {
    return emptyResult(query, resolution, limits, mayBeIncomplete);
  }

  const target = resolution.entity;
  const seeds = targetNodes(graph, target);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const reverse = new Map<string, GraphEdge[]>();

  for (const edge of graph.edges) {
    if (!impactRelations.includes(edge.type)) continue;
    reverse.set(edge.to, [...(reverse.get(edge.to) ?? []), edge]);
  }

  const visited = new Set(seeds.map((node) => node.id));
  const queue = seeds.map((node) => ({ nodeId: node.id, depth: 0, path: [node.id] }));
  const items: ImpactItem[] = [];
  let truncated = false;

  while (queue.length > 0) {
    const current = queue.shift()!;
    if (current.depth >= limits.maxDepth) continue;
    if (items.length >= limits.maxResults) {
      truncated = true;
      break;
    }

    const edges = [...(reverse.get(current.nodeId) ?? [])].sort((left, right) => edgeComparator(nodeById, left, right));
    for (const edge of edges) {
      const entity = nodeById.get(edge.from);
      if (!entity || visited.has(entity.id)) continue;
      visited.add(entity.id);
      const depth = current.depth + 1;
      const path = [...current.path, entity.id];
      items.push({
        entity,
        relation: edge.type,
        direction: "inverse",
        depth,
        path,
        reason: impactReason(edge.type),
        edge,
      });
      if (items.length >= limits.maxResults) {
        truncated = true;
        break;
      }
      queue.push({ nodeId: entity.id, depth, path });
    }
    if (truncated) break;
  }

  items.sort((left, right) => left.depth - right.depth
    || relationPriority[left.relation] - relationPriority[right.relation]
    || nodeKey(left.entity).localeCompare(nodeKey(right.entity))
    || left.path.join(":").localeCompare(right.path.join(":")));
  const summary = summarize(items, target);

  return {
    status: "resolved",
    query,
    target,
    directImpact: items.filter((item) => item.depth === 1),
    transitiveImpact: items.filter((item) => item.depth > 1),
    summary,
    risk: riskFor(summary, mayBeIncomplete),
    mayBeIncomplete,
    limits,
    truncated,
  };
}
