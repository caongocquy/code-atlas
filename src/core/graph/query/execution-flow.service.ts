import { decodeFrameworkRouteIdentity, frameworkEntityKey, frameworkSubjectKey } from "../../framework/framework-identity.js";
import type { FrameworkEntity, FrameworkId, FrameworkProvenance } from "../../framework/framework.types.js";
import type { ReliabilityProjection } from "../../reliability/reliability.types.js";
import type { ResolutionCoverage } from "../resolution.types.js";
import type { CodeGraph, GraphEdge, GraphNode } from "../types.js";
import { GraphQueryEntityResolver } from "./graph-query-entity-resolver.js";
import type { GraphEntityResolution } from "./graph-query.types.js";
import type { FrameworkQueryProjection } from "./framework-query.types.js";

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_NODES = 100;
const MAX_DEPTH = 32;
const MAX_NODES = 1_000;

export type FrameworkRouteSelector = {
  kind: "route";
  framework: Extract<FrameworkId, "nestjs" | "spring" | "next">;
  path: string;
  method?: string | null;
  scope?: string;
  router?: string;
  owner?: string | null;
  conditions?: string[];
};

export type ExecutionFlowEntry = { kind: "symbol"; query: string } | FrameworkRouteSelector | { kind: "graphql"; id: string };

export type ExecutionFlowSubject =
  | { kind: "language"; node: GraphNode }
  | { kind: "framework"; entity: FrameworkEntity };

export type ExecutionFlowNode = {
  id: string;
  subject: ExecutionFlowSubject;
  depth: number;
};

export type ExecutionFlowEdge =
  | {
      kind: "framework_entry";
      from: string;
      to: string;
      relation: "controller_route" | "route_binding" | "graphql_resolver";
      provenance: FrameworkProvenance;
    }
  | {
      kind: "call";
      from: string;
      to: string;
      evidence: GraphEdge[];
    };

export type ExecutionFlowDiagnostic = {
  code: "entry_not_callable" | "route_binding_missing" | "graphql_binding_missing" | "schema_unverified" | "file_bound_route" | "call_target_missing";
  message: string;
  subjectId?: string;
};

export type ExecutionFlowCycle = {
  from: string;
  to: string;
  path: string[];
};

export type ExecutionFlowResolution =
  | { kind: "symbol"; value: GraphEntityResolution }
  | { kind: "route"; status: "resolved"; query: string; entity: FrameworkEntity }
  | { kind: "graphql"; status: "resolved"; query: string; entity: FrameworkEntity }
  | {
      kind: "route" | "graphql";
      status: "ambiguous" | "not_found";
      query: string;
      candidates: Array<FrameworkEntity | GraphNode>;
      reason: "route_identity" | "route_binding" | "graphql_identity" | "graphql_binding" | "framework_unavailable";
    };

export type ExecutionFlowResult = {
  status: "resolved" | "ambiguous" | "not_found";
  entry: ExecutionFlowEntry;
  resolution: ExecutionFlowResolution;
  roots: string[];
  nodes: ExecutionFlowNode[];
  edges: ExecutionFlowEdge[];
  terminals: Array<{ nodeId: string; reason: "no_calls" | "file_bound_route" }>;
  cycles: ExecutionFlowCycle[];
  limits: { maxDepth: number; maxNodes: number };
  truncated: boolean;
  truncatedBy: Array<"maxDepth" | "maxNodes">;
  knownOmittedNodes: number;
  mayBeIncomplete: boolean;
  diagnostics: ExecutionFlowDiagnostic[];
  frameworkReliability?: ReliabilityProjection;
};

type Options = {
  maxDepth?: number;
  maxNodes?: number;
  coverage?: Pick<ResolutionCoverage, "mayBeIncomplete">;
};

function clamp(value: number | undefined, fallback: number, maximum: number): number {
  return Math.max(0, Math.min(maximum, Math.floor(value ?? fallback)));
}

function flowNodeId(subject: ExecutionFlowSubject): string {
  return subject.kind === "language"
    ? frameworkSubjectKey({ kind: "language", nodeId: subject.node.id })
    : frameworkSubjectKey({ kind: "framework", entity: subject.entity.ref });
}

function languageNodeKey(node: GraphNode): string {
  return [node.file, node.type, node.qualifiedName ?? node.name, node.id].join(":");
}

function edgeKey(edge: GraphEdge): string {
  const stable = (value: unknown): string => {
    if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
    if (value && typeof value === "object") {
      return `{${Object.entries(value as Record<string, unknown>).sort(([left], [right]) => left.localeCompare(right)).map(([key, item]) => `${JSON.stringify(key)}:${stable(item)}`).join(",")}}`;
    }
    return JSON.stringify(value) ?? "null";
  };
  return stable(edge);
}

function edgeComparator(nodeById: Map<string, GraphNode>, left: GraphEdge, right: GraphEdge): number {
  const leftTarget = nodeById.get(left.to);
  const rightTarget = nodeById.get(right.to);
  return languageNodeKey(leftTarget ?? { id: left.to, type: "file", name: left.to, file: left.to }).localeCompare(
    languageNodeKey(rightTarget ?? { id: right.to, type: "file", name: right.to, file: right.to }),
  ) || left.from.localeCompare(right.from) || left.to.localeCompare(right.to) || edgeKey(left).localeCompare(edgeKey(right));
}

function routeMatches(entity: FrameworkEntity, selector: FrameworkRouteSelector): boolean {
  if (entity.ref.framework !== selector.framework) return false;
  const identity = decodeFrameworkRouteIdentity(entity.ref);
  if (!identity) return false;
  const [scope, router, path, method, conditions, owner] = identity;
  return path === selector.path
    && (selector.method === undefined || method === (selector.method === null ? null : selector.method.toUpperCase()))
    && (selector.scope === undefined || scope === selector.scope)
    && (selector.router === undefined || router === selector.router)
    && (selector.owner === undefined || owner === selector.owner)
    && (selector.conditions === undefined || JSON.stringify(conditions) === JSON.stringify([...selector.conditions].sort()));
}

function baseResult(entry: ExecutionFlowEntry, limits: ExecutionFlowResult["limits"], mayBeIncomplete: boolean, framework?: FrameworkQueryProjection): ExecutionFlowResult {
  const query = entry.kind === "symbol" ? entry.query : entry.kind === "graphql" ? entry.id : entry.path;
  return {
    status: "not_found",
    entry,
    resolution: entry.kind === "symbol"
      ? { kind: "symbol", value: { status: "not_found", query, candidates: [] } }
      : { kind: entry.kind, status: "not_found", query, candidates: [], reason: framework ? entry.kind === "graphql" ? "graphql_identity" : "route_identity" : "framework_unavailable" },
    roots: [], nodes: [], edges: [], terminals: [], cycles: [], limits,
    truncated: false, truncatedBy: [], knownOmittedNodes: 0,
    mayBeIncomplete: mayBeIncomplete || framework?.mayBeIncomplete === true,
    diagnostics: [],
    ...(framework?.reliability ? { frameworkReliability: framework.reliability } : {}),
  };
}

function entryRelationships(framework: FrameworkQueryProjection, route: FrameworkEntity) {
  const routeKey = frameworkSubjectKey({ kind: "framework", entity: route.ref });
  return framework.edges.flatMap((item) => {
    if (item.kind !== "framework" || item.relationship.target.kind !== "framework"
      || frameworkSubjectKey(item.relationship.target) !== routeKey) return [];
    const relation = item.relationship;
    if (relation.relationKind !== "controller_route" && relation.relationKind !== "route_binding" && relation.relationKind !== "graphql_resolver") return [];
    if (relation.source.kind !== "language") return [];
    return [{ relation, nodeId: relation.source.nodeId }];
  }).sort((left, right) => left.relation.relationKind.localeCompare(right.relation.relationKind)
    || left.nodeId.localeCompare(right.nodeId)
    || JSON.stringify(left.relation.provenance).localeCompare(JSON.stringify(right.relation.provenance)));
}

function unresolved(
  result: ExecutionFlowResult,
  status: "ambiguous" | "not_found",
  resolution: ExecutionFlowResolution,
  incomplete = false,
): ExecutionFlowResult {
  return { ...result, status, resolution, mayBeIncomplete: result.mayBeIncomplete || incomplete };
}

function addRoot(result: ExecutionFlowResult, subject: ExecutionFlowSubject): string {
  const id = flowNodeId(subject);
  result.roots.push(id);
  result.nodes.push({ id, subject, depth: 0 });
  return id;
}

function traverseCalls(graph: CodeGraph, result: ExecutionFlowResult, start: GraphNode): void {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const outgoing = new Map<string, GraphEdge[]>();
  for (const edge of graph.edges) {
    if (edge.type !== "calls") continue;
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge]);
  }
  for (const edges of outgoing.values()) edges.sort((left, right) => edgeComparator(nodeById, left, right));

  const nodesBySubject = new Map(result.nodes.map((node) => [node.id, node]));
  const queue: Array<{ node: GraphNode; depth: number }> = [{ node: start, depth: 0 }];
  const edgeGroups = new Map<string, GraphEdge[]>();
  const markTruncated = (reason: "maxDepth" | "maxNodes") => {
    result.truncated = true;
    if (!result.truncatedBy.includes(reason)) result.truncatedBy.push(reason);
  };

  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const { node, depth } = queue[cursor]!;
    const edges = outgoing.get(node.id) ?? [];
    const validEdges = edges.filter((edge) => nodeById.has(edge.to));
    if (depth >= result.limits.maxDepth) {
      if (validEdges.length > 0) markTruncated("maxDepth");
      continue;
    }
    if (edges.length === 0) result.terminals.push({ nodeId: flowNodeId({ kind: "language", node }), reason: "no_calls" });

    for (let index = 0; index < edges.length; index += 1) {
      const edge = edges[index]!;
      const target = nodeById.get(edge.to);
      if (!target) {
        result.diagnostics.push({ code: "call_target_missing", message: "Call edge has no indexed target endpoint.", subjectId: edge.to });
        result.mayBeIncomplete = true;
        continue;
      }
      const targetId = flowNodeId({ kind: "language", node: target });
      const isNew = !nodesBySubject.has(targetId);
      if (isNew && result.nodes.length >= result.limits.maxNodes) {
        const pendingTargets = new Set(edges.slice(index).flatMap((pending) => {
          const pendingTarget = nodeById.get(pending.to);
          if (!pendingTarget) return [];
          const pendingId = flowNodeId({ kind: "language", node: pendingTarget });
          return nodesBySubject.has(pendingId) ? [] : [pendingId];
        }));
        result.knownOmittedNodes += pendingTargets.size;
        markTruncated("maxNodes");
        break;
      }
      if (isNew) {
        const flowNode = { id: targetId, subject: { kind: "language" as const, node: target }, depth: depth + 1 };
        result.nodes.push(flowNode);
        nodesBySubject.set(targetId, flowNode);
      }
      const groupKey = `${flowNodeId({ kind: "language", node })}\u0000${targetId}`;
      edgeGroups.set(groupKey, [...(edgeGroups.get(groupKey) ?? []), edge]);
      if (isNew) queue.push({ node: target, depth: depth + 1 });
    }
    if (result.truncatedBy.includes("maxNodes")) break;
  }

  result.edges.push(...[...edgeGroups.values()].map((evidence) => {
    const first = evidence[0]!;
    return {
      kind: "call" as const,
      from: flowNodeId({ kind: "language", node: nodeById.get(first.from)! }),
      to: flowNodeId({ kind: "language", node: nodeById.get(first.to)! }),
      evidence: [...evidence].sort((left, right) => edgeKey(left).localeCompare(edgeKey(right))),
    };
  }));

  const callEdges = result.edges.filter((edge): edge is Extract<ExecutionFlowEdge, { kind: "call" }> => edge.kind === "call");
  const callAdjacency = new Map<string, typeof callEdges>();
  for (const edge of callEdges) callAdjacency.set(edge.from, [...(callAdjacency.get(edge.from) ?? []), edge]);
  const states = new Map<string, "visiting" | "visited">();
  const stack: string[] = [];
  const cycleKeys = new Set<string>();
  const visitCycles = (nodeId: string): void => {
    states.set(nodeId, "visiting");
    stack.push(nodeId);
    for (const edge of callAdjacency.get(nodeId) ?? []) {
      if (states.get(edge.to) === "visiting") {
        const cycleStart = stack.indexOf(edge.to);
        const key = `${edge.from}\u0000${edge.to}`;
        if (!cycleKeys.has(key)) {
          cycleKeys.add(key);
          result.cycles.push({ from: edge.from, to: edge.to, path: [...stack.slice(cycleStart), edge.to] });
        }
      } else if (!states.has(edge.to)) {
        visitCycles(edge.to);
      }
    }
    stack.pop();
    states.set(nodeId, "visited");
  };
  visitCycles(flowNodeId({ kind: "language", node: start }));
}

export function discoverExecutionFlow(
  graph: CodeGraph,
  framework: FrameworkQueryProjection | undefined,
  entry: ExecutionFlowEntry,
  options: Options = {},
): ExecutionFlowResult {
  const limits = {
    maxDepth: clamp(options.maxDepth, DEFAULT_MAX_DEPTH, MAX_DEPTH),
    maxNodes: Math.max(1, clamp(options.maxNodes, DEFAULT_MAX_NODES, MAX_NODES)),
  };
  let result = baseResult(entry, limits, options.coverage?.mayBeIncomplete ?? false, framework);

  if (entry.kind === "symbol") {
    const resolution = new GraphQueryEntityResolver(graph).resolve(entry.query);
    if (resolution.status !== "resolved") return unresolved(result, resolution.status, { kind: "symbol", value: resolution });
    result.status = "resolved";
    result.resolution = { kind: "symbol", value: resolution };
    const rootId = addRoot(result, { kind: "language", node: resolution.entity });
    if (resolution.entity.type !== "function" && resolution.entity.type !== "method") {
      result.diagnostics.push({ code: "entry_not_callable", message: "Resolved entry is not a function or method; no call traversal was attempted.", subjectId: resolution.entity.id });
      result.mayBeIncomplete = true;
      result.terminals.push({ nodeId: rootId, reason: "no_calls" });
      return result;
    }
    traverseCalls(graph, result, resolution.entity);
    return result;
  }

  if (!framework) return unresolved(result, "not_found", result.resolution, true);
  const routeMatchesFound = framework.nodes.flatMap((item) => item.kind === "framework" && (entry.kind === "graphql"
    ? (item.entity.ref.kind === "graphql_operation" || item.entity.ref.kind === "graphql_field") && frameworkEntityKey(item.entity.ref) === entry.id
    : routeMatches(item.entity, entry)) ? [item.entity] : [])
    .sort((left, right) => frameworkEntityKey(left.ref).localeCompare(frameworkEntityKey(right.ref)));
  const query = entry.kind === "graphql" ? entry.id : entry.path;
  const identityReason = entry.kind === "graphql" ? "graphql_identity" : "route_identity";
  const bindingReason = entry.kind === "graphql" ? "graphql_binding" : "route_binding";
  if (routeMatchesFound.length === 0) return unresolved(result, "not_found", { kind: entry.kind, status: "not_found", query, candidates: [], reason: identityReason });
  if (routeMatchesFound.length > 1) return unresolved(result, "ambiguous", { kind: entry.kind, status: "ambiguous", query, candidates: routeMatchesFound, reason: identityReason });

  const route = routeMatchesFound[0]!;
  result.status = "resolved";
  result.resolution = { kind: entry.kind, status: "resolved", query, entity: route };
  if (entry.kind === "graphql") {
    result.mayBeIncomplete = true;
    result.diagnostics.push({ code: "schema_unverified", message: "Resolver mapping is declared in code; GraphQL schema exposure and runtime execution are unverified; subscription transport and batch execution are not modeled." });
  }
  const routeId = addRoot(result, { kind: "framework", entity: route });
  const graphNodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const bindings = entryRelationships(framework, route).filter(({ relation, nodeId }) => {
    const node = graphNodeById.get(nodeId);
    if (!node) return false;
    if (entry.kind === "graphql") return relation.relationKind === "graphql_resolver" && (node.type === "function" || node.type === "method");
    if (relation.relationKind === "controller_route") return (entry.framework === "nestjs" || entry.framework === "spring") && (node.type === "function" || node.type === "method");
    return relation.relationKind === "route_binding" && entry.framework === "next" && node.type === "file";
  });
  const boundIds = [...new Set(bindings.map((binding) => binding.nodeId))].sort((left, right) => languageNodeKey(graphNodeById.get(left)!).localeCompare(languageNodeKey(graphNodeById.get(right)!)));
  if (boundIds.length > 1) {
    return unresolved(result, "ambiguous", { kind: entry.kind, status: "ambiguous", query, candidates: boundIds.map((id) => graphNodeById.get(id)!), reason: bindingReason }, true);
  }
  if (boundIds.length === 0) {
    result.diagnostics.push(entry.kind === "graphql"
      ? { code: "graphql_binding_missing", message: "GraphQL mapping has no unique callable resolver binding." }
      : { code: "route_binding_missing", message: "Framework route has no unique callable controller binding or supported file boundary." });
    result.mayBeIncomplete = true;
    result.terminals.push({ nodeId: routeId, reason: "no_calls" });
    return result;
  }

  const bound = graphNodeById.get(boundIds[0]!)!;
  const binding = bindings.find((item) => item.nodeId === bound.id)!;
  const subject: ExecutionFlowSubject = { kind: "language", node: bound };
  const subjectId = flowNodeId(subject);
  if (result.nodes.length >= limits.maxNodes) {
    result.truncated = true;
    result.truncatedBy.push("maxNodes");
    result.knownOmittedNodes = 1;
    result.mayBeIncomplete = true;
    return result;
  }
  result.nodes.push({ id: subjectId, subject, depth: 0 });
  result.edges.push({
    kind: "framework_entry",
    from: routeId,
    to: subjectId,
    relation: binding.relation.relationKind as "controller_route" | "route_binding" | "graphql_resolver",
    provenance: binding.relation.provenance,
  });
  if (bound.type === "file") {
    result.diagnostics.push({ code: "file_bound_route", message: "Framework route is bound only to a file; callable handler ownership was not inferred.", subjectId: bound.id });
    result.mayBeIncomplete = true;
    result.terminals.push({ nodeId: subjectId, reason: "file_bound_route" });
    return result;
  }
  traverseCalls(graph, result, bound);
  return result;
}
