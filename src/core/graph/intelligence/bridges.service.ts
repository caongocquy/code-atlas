import type { CodeGraph, GraphEdge, GraphEdgeType, GraphNode } from "../types.js";
import type {
  ArchitecturalBridge,
  BridgeOptions,
  BridgeResult,
  CommunityCoupling,
  CommunityResult,
} from "./graph-intelligence.types.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;
const relationWeight: Record<GraphEdgeType, number> = { calls: 1, imports: 0.8, extends: 1.2, implements: 1.2, references: 0.9, contains: 0 };

function nodeKey(node: GraphNode): string {
  return [node.file, node.type, node.qualifiedName ?? node.name, node.id].join(":");
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.from}:${edge.to}:${edge.type}`;
}

function directoryOf(file: string): string {
  const separator = file.lastIndexOf("/");
  return separator < 0 ? "." : file.slice(0, separator) || ".";
}

function clampLimit(value: number | undefined): number {
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value ?? DEFAULT_LIMIT)));
}

function likelyNoisyHub(node: GraphNode, totalDegree: number, crossCommunityDegree: number, maxDegree: number): boolean {
  const generated = /(^|\/)(node_modules|dist|build|coverage|generated|vendor|\.codeatlas)(\/|$)/i.test(node.file);
  const hub = totalDegree >= Math.max(8, maxDegree * 0.8) && crossCommunityDegree >= 4;
  return generated || hub;
}

function communityMembership(result: CommunityResult): Map<string, string> {
  if (Object.keys(result.membership).length > 0) return new Map(Object.entries(result.membership));
  const membership = new Map<string, string>();
  for (const community of result.communities) {
    for (const memberId of community.memberIds) membership.set(memberId, community.id);
  }
  return membership;
}

function couplingKey(sourceCommunityId: string, targetCommunityId: string): string {
  return `${sourceCommunityId}\0${targetCommunityId}`;
}

export function detectArchitecturalBridges(
  graph: CodeGraph,
  communities: CommunityResult,
  options: BridgeOptions = {},
): BridgeResult {
  const limit = clampLimit(options.limit);
  const membership = communityMembership(communities);
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const externalDegree = new Map<string, number>();
  const totalDegree = new Map<string, number>();
  const pairCounts = new Map<string, number>();
  const candidates: Array<{ edge: GraphEdge; source: GraphNode; target: GraphNode; sourceCommunityId: string; targetCommunityId: string }> = [];

  for (const edge of graph.edges) {
    totalDegree.set(edge.from, (totalDegree.get(edge.from) ?? 0) + 1);
    totalDegree.set(edge.to, (totalDegree.get(edge.to) ?? 0) + 1);
    if (edge.type === "contains") continue;
    const source = nodeById.get(edge.from);
    const target = nodeById.get(edge.to);
    const sourceCommunityId = membership.get(edge.from);
    const targetCommunityId = membership.get(edge.to);
    if (!source || !target || !sourceCommunityId || !targetCommunityId || sourceCommunityId === targetCommunityId) continue;
    const key = couplingKey(sourceCommunityId, targetCommunityId);
    pairCounts.set(key, (pairCounts.get(key) ?? 0) + 1);
    externalDegree.set(source.id, (externalDegree.get(source.id) ?? 0) + 1);
    externalDegree.set(target.id, (externalDegree.get(target.id) ?? 0) + 1);
    candidates.push({ edge, source, target, sourceCommunityId, targetCommunityId });
  }

  const maxDegree = graph.nodes.reduce((maximum, node) => Math.max(maximum, totalDegree.get(node.id) ?? 0), 0);
  const bridges = candidates
    .filter(({ edge, source, target, sourceCommunityId, targetCommunityId }) => {
      const pairCount = pairCounts.get(couplingKey(sourceCommunityId, targetCommunityId)) ?? 0;
      const sparsePair = pairCount <= 2;
      const lowEndpointDegree = (externalDegree.get(source.id) ?? 0) <= 2 && (externalDegree.get(target.id) ?? 0) <= 2;
      const crossesDirectory = directoryOf(source.file) !== directoryOf(target.file);
      const boundaryRelation = source.type === "file" || target.type === "file"
        || edge.type === "imports"
        || edge.type === "extends"
        || source.type === "class"
        || target.type === "class"
        || source.type === "interface"
        || target.type === "interface";
      return !likelyNoisyHub(source, totalDegree.get(source.id) ?? 0, externalDegree.get(source.id) ?? 0, maxDegree)
        && !likelyNoisyHub(target, totalDegree.get(target.id) ?? 0, externalDegree.get(target.id) ?? 0, maxDegree)
        && (crossesDirectory || boundaryRelation)
        && (sparsePair || lowEndpointDegree);
    })
    .map<ArchitecturalBridge>(({ edge, source, target, sourceCommunityId, targetCommunityId }) => {
      const pairCount = pairCounts.get(couplingKey(sourceCommunityId, targetCommunityId)) ?? 1;
      const endpointDegree = (externalDegree.get(source.id) ?? 0) + (externalDegree.get(target.id) ?? 0);
      const score = relationWeight[edge.type] / (pairCount * Math.sqrt(Math.max(1, endpointDegree)));
      const reason = pairCount === 1
        ? "sole edge between two communities"
        : "sparse edge between two communities with low endpoint coupling";
      return { edge, source, target, sourceCommunityId, targetCommunityId, score, reason };
    })
    .sort((left, right) => right.score - left.score || nodeKey(left.source).localeCompare(nodeKey(right.source)) || nodeKey(left.target).localeCompare(nodeKey(right.target)) || edgeKey(left.edge).localeCompare(edgeKey(right.edge)));

  return {
    bridges: bridges.slice(0, limit),
    coupling: communities.coupling,
    totalCandidates: bridges.length,
    truncated: bridges.length > limit,
    mayBeIncomplete: options.coverage?.mayBeIncomplete ?? communities.mayBeIncomplete,
  };
}
