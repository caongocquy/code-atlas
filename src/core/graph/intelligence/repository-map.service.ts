import { classifyArchitectureFile, type ArchitecturePolicy, type ArchitectureMembership } from "../../architecture/architecture-policy.js";
import type { FrameworkId } from "../../framework/framework.types.js";
import type { FrameworkQueryProjection } from "../query/framework-query.types.js";
import { detectCommunities } from "./communities.service.js";
import { calculateImportance } from "./importance.service.js";
import type { CodeGraph, GraphEdge, GraphEdgeType, GraphNode } from "../types.js";
import type { RepositoryMap, RepositoryMapArea, RepositoryMapDiagnostics, RepositoryMapOptions, RepositoryMapRelation } from "./repository-map.types.js";

const MAP_EDGE_TYPES = new Set<GraphEdgeType>(["calls", "imports", "extends", "implements", "references"]);
const ROUTE_ENTRY_RELATIONS = new Set(["controller_route", "route_binding"]);
const MAX_REPRESENTATIVES = 5;
const MAX_RESULTS = 10_000;

function nodeKey(node: GraphNode): string {
  return [node.file, node.type, node.qualifiedName ?? node.name, node.id].join(":");
}

function directoryOf(file: string): string {
  const separator = file.lastIndexOf("/");
  return separator < 0 ? "." : file.slice(0, separator) || ".";
}

function emptyCounts() {
  return { internal: 0, external: 0 };
}

function compareAreas(left: RepositoryMapArea, right: RepositoryMapArea): number {
  return right.symbolCount - left.symbolCount || right.fileCount - left.fileCount || left.id.localeCompare(right.id);
}

function capPaths(paths: Set<string>, limit: number): { count: number; paths: string[] } {
  const sorted = [...paths].sort();
  return { count: sorted.length, paths: sorted.slice(0, limit) };
}

function frameworkAreaFacets(
  projection: FrameworkQueryProjection | undefined,
  areaByNodeId: Map<string, string>,
): Map<string, { ids: Set<FrameworkId>; entries: number }> {
  const result = new Map<string, { ids: Set<FrameworkId>; entries: number }>();
  const facet = (areaId: string, framework: FrameworkId, routeEntry = false) => {
    const item = result.get(areaId) ?? { ids: new Set<FrameworkId>(), entries: 0 };
    item.ids.add(framework);
    if (routeEntry) item.entries += 1;
    result.set(areaId, item);
  };
  if (!projection) return result;
  for (const edge of projection.edges) {
    if (edge.kind !== "framework") continue;
    const relation = edge.relationship;
    const areaIds = new Set([relation.source, relation.target]
      .filter((subject) => subject.kind === "language")
      .map((subject) => areaByNodeId.get(subject.nodeId))
      .filter((areaId): areaId is string => areaId !== undefined));
    for (const areaId of areaIds) facet(areaId, relation.provenance.framework, ROUTE_ENTRY_RELATIONS.has(relation.relationKind));
  }
  for (const item of projection.classifications) {
    if (item.subject.kind !== "language") continue;
    const areaId = areaByNodeId.get(item.subject.nodeId);
    if (areaId) facet(areaId, item.provenance.framework);
  }
  return result;
}

function relationKey(sourceAreaId: string, targetAreaId: string): string {
  return `${sourceAreaId}\0${targetAreaId}`;
}

export function buildRepositoryMap(
  graph: CodeGraph,
  policy: ArchitecturePolicy,
  framework?: FrameworkQueryProjection,
  options: RepositoryMapOptions = {},
): RepositoryMap {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const areaByNodeId = new Map<string, string>();
  const fileMembership = new Map<string, ArchitectureMembership>();
  const areas: RepositoryMapArea[] = [];
  const countsByArea = new Map<string, { internal: number; external: number }>();
  const membersByArea = new Map<string, GraphNode[]>();
  const source = policy.groups.length > 0 ? "architecture_group" : "structural_community";
  const identityStability = source === "architecture_group" ? "configuration_stable" : "graph_generation_member_set";
  const communities = source === "structural_community"
    ? detectCommunities(graph, { maxResults: MAX_RESULTS, includeSingletons: true, coverage: { mayBeIncomplete: options.graphMayBeIncomplete ?? false } })
    : undefined;
  const communityById = new Map(communities?.communities.map((community) => [community.id, community]) ?? []);
  const filesByArea = new Map<string, Set<string>>();
  const ambiguousFiles = new Set<string>();
  const unclassifiedFiles = new Set<string>();

  for (const node of graph.nodes) {
    if (source === "architecture_group" && !fileMembership.has(node.file)) {
      const membership = classifyArchitectureFile(policy, node.file);
      fileMembership.set(node.file, membership);
      if (membership.state === "ambiguous") ambiguousFiles.add(node.file);
      if (membership.state === "unclassified") unclassifiedFiles.add(node.file);
    }
    let areaId: string | undefined;
    if (source === "architecture_group") {
      const membership = fileMembership.get(node.file)!;
      if (membership.state === "classified") areaId = membership.groupId;
    } else {
      areaId = communities?.membership[node.id];
      if (areaId && !communityById.has(areaId)) areaId = undefined;
    }
    if (!areaId) continue;
    areaByNodeId.set(node.id, areaId);
    const members = membersByArea.get(areaId) ?? [];
    members.push(node);
    membersByArea.set(areaId, members);
    const files = filesByArea.get(areaId) ?? new Set<string>();
    files.add(node.file);
    filesByArea.set(areaId, files);
  }

  if (source === "architecture_group") {
    for (const group of policy.groups) {
      const members = membersByArea.get(group.id) ?? [];
      areas.push({
        id: group.id, label: group.id, boundarySource: source, identityStability,
        identitySemantics: "ID is the configured architecture group ID and remains stable while configuration identity is unchanged.",
        fileCount: filesByArea.get(group.id)?.size ?? 0,
        symbolCount: members.filter((node) => node.type !== "file").length,
        memberIds: members.map((node) => node.id).sort(),
        files: [...(filesByArea.get(group.id) ?? [])].sort(),
        directories: [...new Set([...(filesByArea.get(group.id) ?? [])].map(directoryOf))].sort(),
        representativeSymbols: [], internalEdgeCount: 0, externalEdgeCount: 0, cohesion: 0, coupling: 0,
        frameworkIds: [], executionEntryBindingCount: 0,
      });
    }
  } else {
    for (const community of communities?.communities ?? []) {
      areas.push({
        id: community.id, label: community.label, boundarySource: source, identityStability,
        identitySemantics: "ID is deterministic for this graph generation and member set; membership changes can change the ID.",
        fileCount: community.files.length, symbolCount: community.size, memberIds: [...community.memberIds], files: [...community.files], directories: [...community.directories],
        representativeSymbols: [...community.representatives], internalEdgeCount: community.internalEdgeCount,
        externalEdgeCount: community.externalEdgeCount, cohesion: community.cohesion, coupling: community.coupling,
        frameworkIds: [], executionEntryBindingCount: 0,
      });
    }
  }

  areas.sort(compareAreas);
  const areaById = new Map(areas.map((area) => [area.id, area]));
  for (const area of areas) countsByArea.set(area.id, emptyCounts());
  if (source === "architecture_group") {
    const importance = calculateImportance(graph, { limit: 1_000, coverage: { mayBeIncomplete: options.graphMayBeIncomplete ?? false } });
    const candidatesByArea = new Map<string, GraphNode[]>();
    for (const item of importance.items) {
      const areaId = areaByNodeId.get(item.symbol.id);
      if (!areaId) continue;
      const candidates = candidatesByArea.get(areaId) ?? [];
      candidates.push(item.symbol);
      candidatesByArea.set(areaId, candidates);
    }
    for (const area of areas) {
      const important = candidatesByArea.get(area.id) ?? [];
      const selectedIds = new Set(important.map((item) => item.id));
      const deterministicFill = (membersByArea.get(area.id) ?? [])
        .filter((item) => item.type !== "file" && !selectedIds.has(item.id))
        .sort((left, right) => nodeKey(left).localeCompare(nodeKey(right)));
      area.representativeSymbols = [...important, ...deterministicFill].slice(0, MAX_REPRESENTATIVES);
    }
  }

  const relationEdges = new Map<string, GraphEdge[]>();
  let unmappedEdgeCount = 0;
  let ambiguousEndpointCount = 0;
  let unclassifiedEndpointCount = 0;
  let missingEndpointCount = 0;
  for (const edge of graph.edges) {
    if (!MAP_EDGE_TYPES.has(edge.type)) continue;
    const sourceNode = nodeById.get(edge.from);
    const targetNode = nodeById.get(edge.to);
    const sourceAreaId = areaByNodeId.get(edge.from);
    const targetAreaId = areaByNodeId.get(edge.to);
    if (!sourceAreaId || !targetAreaId) {
      unmappedEdgeCount += 1;
      for (const [node, areaId] of [[sourceNode, sourceAreaId], [targetNode, targetAreaId]] as const) {
        if (areaId) continue;
        if (!node) { missingEndpointCount += 1; continue; }
        const membership = fileMembership.get(node.file);
        if (membership?.state === "ambiguous") ambiguousEndpointCount += 1;
        else if (membership?.state === "unclassified") unclassifiedEndpointCount += 1;
      }
    }
    if (sourceAreaId) {
      const counts = countsByArea.get(sourceAreaId)!;
      if (sourceAreaId === targetAreaId) counts.internal += 1;
      else counts.external += 1;
    }
    if (targetAreaId && targetAreaId !== sourceAreaId) countsByArea.get(targetAreaId)!.external += 1;
    if (!sourceAreaId || !targetAreaId || sourceAreaId === targetAreaId) continue;
    const key = relationKey(sourceAreaId, targetAreaId);
    const edges = relationEdges.get(key) ?? [];
    edges.push(edge);
    relationEdges.set(key, edges);
  }

  if (source === "architecture_group") {
    for (const area of areas) {
      const counts = countsByArea.get(area.id)!;
      area.internalEdgeCount = counts.internal;
      area.externalEdgeCount = counts.external;
      const total = counts.internal + counts.external;
      area.cohesion = total === 0 ? 0 : counts.internal / total;
      area.coupling = area.symbolCount === 0 ? 0 : counts.external / area.symbolCount;
    }
  }
  const facets = frameworkAreaFacets(framework, areaByNodeId);
  for (const [areaId, facet] of facets) {
    const area = areaById.get(areaId);
    if (!area) continue;
    area.frameworkIds = [...facet.ids].sort();
    area.executionEntryBindingCount = facet.entries;
  }

  const relations: RepositoryMapRelation[] = [...relationEdges.entries()].map(([key, edges]) => {
    const [sourceAreaId, targetAreaId] = key.split("\0");
    const relationCounts: Partial<Record<GraphEdgeType, number>> = {};
    for (const edge of edges) relationCounts[edge.type] = (relationCounts[edge.type] ?? 0) + 1;
    return {
      sourceAreaId: sourceAreaId!, targetAreaId: targetAreaId!, edgeCount: edges.length, relationCounts,
      representativeEdges: [...edges].sort((left, right) => `${left.from}:${left.to}:${left.type}`.localeCompare(`${right.from}:${right.to}:${right.type}`)).slice(0, MAX_REPRESENTATIVES),
    };
  }).sort((left, right) => right.edgeCount - left.edgeCount || left.sourceAreaId.localeCompare(right.sourceAreaId) || left.targetAreaId.localeCompare(right.targetAreaId));

  const frameworkMayBeIncomplete = framework?.mayBeIncomplete ?? true;
  const graphMayBeIncomplete = options.graphMayBeIncomplete ?? false;
  const structuralCommunitiesTruncated = communities?.truncated ?? false;
  const diagnostics: RepositoryMapDiagnostics = {
    ambiguousFiles: capPaths(ambiguousFiles, options.maxDiagnosticPaths ?? MAX_RESULTS),
    unclassifiedFiles: capPaths(unclassifiedFiles, options.maxDiagnosticPaths ?? MAX_RESULTS),
    unmappedArchitecturalEdges: { count: unmappedEdgeCount, ambiguousEndpointCount, unclassifiedEndpointCount, missingEndpointCount },
    incompleteEvidence: { graph: graphMayBeIncomplete, framework: frameworkMayBeIncomplete, structuralCommunitiesTruncated },
    truncation: {
      diagnosticPaths: ambiguousFiles.size > (options.maxDiagnosticPaths ?? MAX_RESULTS) || unclassifiedFiles.size > (options.maxDiagnosticPaths ?? MAX_RESULTS),
      areas: false, files: false, relations: false, representativeEdges: false, frameworkDiagnostics: false,
    },
    frameworkDiagnostics: framework?.diagnostics ?? [], frameworkCoverage: framework?.coverage ?? [],
  };
  const classificationMayBeIncomplete = source === "architecture_group" && (ambiguousFiles.size > 0 || unclassifiedFiles.size > 0);
  const mayBeIncomplete = graphMayBeIncomplete || frameworkMayBeIncomplete || classificationMayBeIncomplete || structuralCommunitiesTruncated;
  return {
    boundarySource: source, identityStability, areas, relations, diagnostics,
    coverage: { graphMayBeIncomplete, frameworkMayBeIncomplete, classificationMayBeIncomplete, mayBeIncomplete },
    mayBeIncomplete, ...(framework?.reliability ? { frameworkReliability: framework.reliability } : {}),
  };
}
