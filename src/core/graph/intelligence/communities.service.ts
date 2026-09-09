import { createHash } from "node:crypto";

import type { CodeGraph, GraphEdge, GraphEdgeType, GraphNode } from "../types.js";
import type {
  CommunityCoupling,
  CommunityOptions,
  CommunityResult,
  CommunityQuality,
  GraphCommunity,
} from "./graph-intelligence.types.js";

const DEFAULT_MAX_RESULTS = 10_000;
const MAX_RESULTS = 10_000;
const DEFAULT_MAX_COMMUNITY_SIZE = 200;
const MODULARITY_ITERATIONS = 20;
const communityEdgeTypes = new Set<GraphEdgeType>(["calls", "imports", "extends", "implements", "references", "contains"]);
const couplingEdgeTypes = new Set<GraphEdgeType>(["calls", "imports", "extends", "implements", "references"]);
const edgeWeight: Record<GraphEdgeType, number> = { calls: 3, extends: 2, implements: 2, references: 1, imports: 1.5, contains: 0.5 };

function nodeKey(node: GraphNode): string {
  return [node.file, node.type, node.qualifiedName ?? node.name, node.id].join(":");
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.from}:${edge.to}:${edge.type}`;
}

function clamp(value: number | undefined, fallback: number, maximum: number): number {
  return Math.max(1, Math.min(maximum, Math.floor(value ?? fallback)));
}

function addNeighbor(adjacency: Map<string, Map<string, number>>, from: string, to: string, weight: number): void {
  const neighbors = adjacency.get(from) ?? new Map<string, number>();
  neighbors.set(to, (neighbors.get(to) ?? 0) + weight);
  adjacency.set(from, neighbors);
}

function sortedNodes(graph: CodeGraph): GraphNode[] {
  return [...graph.nodes].sort((left, right) => nodeKey(left).localeCompare(nodeKey(right)));
}

function buildCommunities(graph: CodeGraph): Map<string, string[]> {
  const nodes = sortedNodes(graph);
  const adjacency = new Map<string, Map<string, number>>();
  const labels = new Map(nodes.map((node) => [node.id, node.id]));
  const degree = new Map<string, number>();

  for (const edge of [...graph.edges].sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)))) {
    if (!communityEdgeTypes.has(edge.type)) continue;
    addNeighbor(adjacency, edge.from, edge.to, edgeWeight[edge.type]);
    addNeighbor(adjacency, edge.to, edge.from, edgeWeight[edge.type]);
    degree.set(edge.from, (degree.get(edge.from) ?? 0) + edgeWeight[edge.type]);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + edgeWeight[edge.type]);
  }

  const totalDegree = [...degree.values()].reduce((total, value) => total + value, 0);
  const communityTotals = new Map(nodes.map((node) => [node.id, degree.get(node.id) ?? 0] as const));
  // One-level weighted modularity local moving keeps the algorithm explainable,
  // deterministic, and O(iterations * (nodes + edges)) for this graph size.
  for (let iteration = 0; iteration < MODULARITY_ITERATIONS; iteration += 1) {
    let changed = false;
    for (const node of nodes) {
      const nodeDegree = degree.get(node.id) ?? 0;
      const current = labels.get(node.id)!;
      communityTotals.set(current, (communityTotals.get(current) ?? 0) - nodeDegree);
      const totals = new Map<string, number>();
      for (const [neighbor, weight] of adjacency.get(node.id) ?? []) {
        const label = labels.get(neighbor);
        if (label) totals.set(label, (totals.get(label) ?? 0) + weight);
      }
      const best = [...totals.entries()]
        .map(([label, internalWeight]) => ({
          label,
          gain: internalWeight - (nodeDegree * (communityTotals.get(label) ?? 0)) / Math.max(1, totalDegree),
        }))
        .sort((left, right) => right.gain - left.gain || left.label.localeCompare(right.label))[0];
      if (best && best.gain > 0) {
        labels.set(node.id, best.label);
        communityTotals.set(best.label, (communityTotals.get(best.label) ?? 0) + nodeDegree);
        changed = true;
      } else {
        communityTotals.set(current, (communityTotals.get(current) ?? 0) + nodeDegree);
      }
    }
    if (!changed) break;
  }

  const members = new Map<string, string[]>();
  for (const node of nodes) {
    const label = labels.get(node.id)!;
    members.set(label, [...(members.get(label) ?? []), node.id]);
  }
  return members;
}

function stableCommunityId(memberIds: string[]): string {
  return `community-${createHash("sha256").update([...memberIds].sort().join("\0")).digest("hex").slice(0, 16)}`;
}

function directoryOf(file: string): string {
  const separator = file.lastIndexOf("/");
  return separator < 0 ? "." : file.slice(0, separator) || ".";
}

function readableLabel(nodes: GraphNode[]): string {
  const directories = new Map<string, number>();
  for (const node of nodes) directories.set(directoryOf(node.file), (directories.get(directoryOf(node.file)) ?? 0) + 1);
  const dominant = [...directories.entries()].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))[0]?.[0];
  return dominant ?? nodes[0]?.qualifiedName ?? nodes[0]?.name ?? "root";
}

function qualityFor(size: number, maxSize: number): CommunityQuality {
  if (size > maxSize) return "oversized";
  if (size <= 1) return "singleton";
  if (size < 3) return "tiny";
  return "normal";
}

function relationCounts(edges: GraphEdge[]): Partial<Record<GraphEdgeType, number>> {
  return edges.reduce<Partial<Record<GraphEdgeType, number>>>((counts, edge) => {
    counts[edge.type] = (counts[edge.type] ?? 0) + 1;
    return counts;
  }, {});
}

function representativeNodes(nodes: GraphNode[], internalDegrees: Map<string, number>): GraphNode[] {
  const kindPriority: Record<GraphNode["type"], number> = {
    class: 5,
    interface: 5,
    enum: 4,
    function: 4,
    method: 3,
    type: 3,
    variable: 1,
    file: 0,
  };
  return nodes
    .filter((node) => node.type !== "file")
    .sort((left, right) => kindPriority[right.type] - kindPriority[left.type]
      || (internalDegrees.get(right.id) ?? 0) - (internalDegrees.get(left.id) ?? 0)
      || nodeKey(left).localeCompare(nodeKey(right)))
    .slice(0, 5);
}

function buildCommunity(
  graph: CodeGraph,
  memberIds: string[],
  maxSize: number,
  edgeStats: { internal: number; external: number },
  internalDegrees: Map<string, number>,
): GraphCommunity {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const members = memberIds.map((id) => nodeById.get(id)).filter((node): node is GraphNode => node !== undefined);
  const symbols = members.filter((node) => node.type !== "file");
  const files = [...new Set(members.map((node) => node.file))].sort();
  const directories = [...new Set(files.map(directoryOf))].sort();
  const totalEdges = edgeStats.internal + edgeStats.external;
  const id = stableCommunityId(memberIds);
  return {
    id,
    label: readableLabel(symbols.length > 0 ? symbols : members),
    size: symbols.length,
    memberIds: [...memberIds].sort(),
    representatives: representativeNodes(members, internalDegrees),
    files,
    directories,
    internalEdgeCount: edgeStats.internal,
    externalEdgeCount: edgeStats.external,
    cohesion: totalEdges === 0 ? 0 : edgeStats.internal / totalEdges,
    coupling: symbols.length === 0 ? 0 : edgeStats.external / symbols.length,
    quality: qualityFor(symbols.length, maxSize),
  };
}

function buildCoupling(graph: CodeGraph, membership: Map<string, string>): CommunityCoupling[] {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const grouped = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    if (!couplingEdgeTypes.has(edge.type)) continue;
    const sourceCommunityId = membership.get(edge.from);
    const targetCommunityId = membership.get(edge.to);
    if (!sourceCommunityId || !targetCommunityId || sourceCommunityId === targetCommunityId) continue;
    const key = `${sourceCommunityId}\0${targetCommunityId}`;
    grouped.set(key, [...(grouped.get(key) ?? []), edge]);
  }
  return [...grouped.entries()].map(([key, edges]) => {
    const [sourceCommunityId, targetCommunityId] = key.split("\0");
    const sortedEdges = [...edges].sort((left, right) => edgeKey(left).localeCompare(edgeKey(right)));
    const symbolCounts = new Map<string, number>();
    for (const edge of edges) {
      symbolCounts.set(edge.from, (symbolCounts.get(edge.from) ?? 0) + 1);
      symbolCounts.set(edge.to, (symbolCounts.get(edge.to) ?? 0) + 1);
    }
    return {
      sourceCommunityId,
      targetCommunityId,
      edgeCount: edges.length,
      relationCounts: relationCounts(edges),
      representativeEdges: sortedEdges.slice(0, 5).map((edge) => ({ ...edge, from: nodeById.get(edge.from)?.id ?? edge.from, to: nodeById.get(edge.to)?.id ?? edge.to })),
      representativeSymbols: [...symbolCounts.entries()]
        .map(([id, count]) => ({ node: nodeById.get(id), count }))
        .filter((item): item is { node: GraphNode; count: number } => item.node !== undefined)
        .sort((left, right) => right.count - left.count || nodeKey(left.node).localeCompare(nodeKey(right.node)))
        .slice(0, 5)
        .map((item) => item.node),
    };
  }).sort((left, right) => left.sourceCommunityId.localeCompare(right.sourceCommunityId) || left.targetCommunityId.localeCompare(right.targetCommunityId));
}

export function detectCommunities(graph: CodeGraph, options: CommunityOptions = {}): CommunityResult {
  const maxResults = clamp(options.maxResults, DEFAULT_MAX_RESULTS, MAX_RESULTS);
  const maxCommunitySize = clamp(options.maxCommunitySize, DEFAULT_MAX_COMMUNITY_SIZE, 10_000);
  const membersByLabel = buildCommunities(graph);
  const labels = [...membersByLabel.keys()].sort();
  const membership = new Map<string, string>();
  const rawCommunities = labels.map((label) => {
    const memberIds = membersByLabel.get(label)!.sort();
    const id = stableCommunityId(memberIds);
    for (const memberId of memberIds) membership.set(memberId, id);
    return memberIds;
  });
  const edgeStats = new Map<string, { internal: number; external: number }>();
  const internalDegrees = new Map<string, number>();
  for (const edge of graph.edges) {
    if (!couplingEdgeTypes.has(edge.type)) continue;
    const sourceCommunityId = membership.get(edge.from);
    const targetCommunityId = membership.get(edge.to);
    if (!sourceCommunityId || !targetCommunityId) continue;
    if (sourceCommunityId === targetCommunityId) {
      const stats = edgeStats.get(sourceCommunityId) ?? { internal: 0, external: 0 };
      stats.internal += 1;
      edgeStats.set(sourceCommunityId, stats);
      internalDegrees.set(edge.from, (internalDegrees.get(edge.from) ?? 0) + 1);
      internalDegrees.set(edge.to, (internalDegrees.get(edge.to) ?? 0) + 1);
    } else {
      const sourceStats = edgeStats.get(sourceCommunityId) ?? { internal: 0, external: 0 };
      const targetStats = edgeStats.get(targetCommunityId) ?? { internal: 0, external: 0 };
      sourceStats.external += 1;
      targetStats.external += 1;
      edgeStats.set(sourceCommunityId, sourceStats);
      edgeStats.set(targetCommunityId, targetStats);
    }
  }
  const communities = rawCommunities
    .map((memberIds) => buildCommunity(graph, memberIds, maxCommunitySize, edgeStats.get(membership.get(memberIds[0]!)!) ?? { internal: 0, external: 0 }, internalDegrees))
    .sort((left, right) => right.size - left.size || left.id.localeCompare(right.id));
  const visible = options.includeSingletons === false
    ? communities.filter((community) => community.quality !== "singleton")
    : communities;
  const coupling = buildCoupling(graph, membership);
  return {
    communities: visible.slice(0, maxResults),
    membership: Object.fromEntries(membership),
    coupling,
    totalCommunities: communities.length,
    largestCommunitySize: communities[0]?.size ?? 0,
    crossCommunityEdgeCount: coupling.reduce((total, item) => total + item.edgeCount, 0),
    truncated: visible.length > maxResults,
    mayBeIncomplete: options.coverage?.mayBeIncomplete ?? false,
  };
}

export function getCommunityById(result: CommunityResult, id: string): GraphCommunity | undefined {
  return result.communities.find((community) => community.id === id);
}
