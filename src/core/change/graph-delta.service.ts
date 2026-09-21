import { getRepoId } from "../repository/repository-files.js";
import {
  createCoverageDiagnostics,
} from "../diagnostics/coverage-diagnostics.service.js";
import { mergeResolutionCoverage } from "../graph/resolution.types.js";
import type { GraphEdge, GraphNode } from "../graph/types.js";
import { readGitChangeSources } from "../../infrastructure/git/git-change-reader.js";
import type { GitChangeSet } from "../../infrastructure/git/git-change-reader.js";
import { buildTransientGraph, graphNodeById } from "./transient-graph.js";
import type {
  FileReference,
  GraphDeltaInput,
  GraphDeltaResult,
  StructuralEdge,
  StructuralReference,
  StructuralSymbolReference,
} from "./graph-delta.types.js";
import type { TransientGraph } from "./transient-graph.js";

const DEFAULT_MAX_EDGES = 1_000;

function edgeNode(node: GraphNode): StructuralReference {
  if (node.type === "file") return { file: node.file } satisfies FileReference;
  return {
    symbolId: node.id,
    name: node.name,
    kind: node.type,
    file: node.file,
    ...(node.qualifiedName ? { qualifiedName: node.qualifiedName } : {}),
    ...(node.startLine === undefined ? {} : { startLine: node.startLine }),
    ...(node.endLine === undefined ? {} : { endLine: node.endLine }),
  } satisfies StructuralSymbolReference;
}

export function structuralEdges(graph: { edges: GraphEdge[]; nodes: GraphNode[] }): StructuralEdge[] {
  const nodes = graphNodeById(graph);
  const result = new Map<string, StructuralEdge>();
  for (const edge of graph.edges) {
    if (edge.type !== "imports" && edge.type !== "calls") continue;
    const from = nodes.get(edge.from);
    const to = nodes.get(edge.to);
    if (!from || !to) continue;
    const value: StructuralEdge = {
      from: edgeNode(from),
      to: edgeNode(to),
      kind: edge.type,
      ...(edge.resolutionMethod ? {
        resolution: {
          strategy: edge.resolutionMethod,
          confidence: (edge.confidence ?? 0) >= 0.9 ? "high" : (edge.confidence ?? 0) >= 0.6 ? "medium" : "low",
        },
      } : {}),
      evidence: {
        source: "transient_source_analysis",
        ...(edge.resolutionMethod ? { resolutionStrategy: edge.resolutionMethod } : {}),
      },
    };
    result.set(edgeIdentity(value), value);
  }
  return [...result.values()].sort(compareEdges);
}

function pathFor(file: string, renames: Map<string, string>): string {
  return renames.get(file) ?? file;
}

function referenceIdentity(reference: StructuralReference, renames: Map<string, string>): string {
  if (!("symbolId" in reference)) return `file:${pathFor(reference.file, renames)}`;
  return `symbol:${pathFor(reference.file, renames)}:${reference.kind}:${reference.qualifiedName ?? reference.name}`;
}

function edgeIdentity(edge: StructuralEdge, renames: Map<string, string> = new Map()): string {
  return `${edge.kind}:${referenceIdentity(edge.from, renames)}>${referenceIdentity(edge.to, renames)}`;
}

function displayReference(reference: StructuralReference): string {
  return "symbolId" in reference ? `${reference.file}:${reference.qualifiedName ?? reference.name}` : reference.file;
}

function compareEdges(left: StructuralEdge, right: StructuralEdge): number {
  return left.kind.localeCompare(right.kind)
    || displayReference(left.from).localeCompare(displayReference(right.from))
    || displayReference(left.to).localeCompare(displayReference(right.to));
}

function maxEdges(input: GraphDeltaInput): number {
  const value = input.maxEdges ?? DEFAULT_MAX_EDGES;
  if (!Number.isInteger(value) || value < 1 || value > 10_000) {
    throw new Error("maxEdges must be an integer from 1 to 10000.");
  }
  return value;
}

export async function graphDelta(
  repoPath: string,
  input: GraphDeltaInput = {},
): Promise<GraphDeltaResult> {
  return compareGraphDeltaContext(await readGraphDeltaContext(repoPath, input), input);
}

export type GraphDeltaContext = {
  changes: GitChangeSet;
  beforeSnapshot: import("../../infrastructure/git/git-change-reader.js").GitSourceSnapshot;
  afterSnapshot: import("../../infrastructure/git/git-change-reader.js").GitSourceSnapshot;
  before: TransientGraph;
  after: TransientGraph;
  renames: Map<string, string>;
  baselineState: import("../../infrastructure/git/git-change-reader.js").GitSourceState;
  targetState: import("../../infrastructure/git/git-change-reader.js").GitSourceState;
};

export async function readGraphDeltaContext(
  repoPath: string,
  input: GraphDeltaInput = {},
): Promise<GraphDeltaContext> {
  const sources = await readGitChangeSources(repoPath, input);
  const repoId = getRepoId(repoPath);
  return {
    changes: sources.changes,
    beforeSnapshot: sources.baseline,
    afterSnapshot: sources.target,
    before: buildTransientGraph(sources.baseline, repoId),
    after: buildTransientGraph(sources.target, repoId),
    baselineState: sources.baselineState,
    targetState: sources.targetState,
    renames: new Map(
    sources.changes.files
      .filter((file) => file.status === "renamed" && file.oldPath)
      .map((file) => [file.oldPath!, file.path]),
    ),
  };
}

export function compareGraphDeltaContext(
  context: GraphDeltaContext,
  input: GraphDeltaInput = {},
): GraphDeltaResult {
  const { changes, before, after, renames } = context;
  const beforeEdges = new Map(before.graph.edges
    .filter((edge) => edge.type === "imports" || edge.type === "calls")
    .map((edge) => {
      const nodes = graphNodeById(before.graph);
      const from = nodes.get(edge.from);
      const to = nodes.get(edge.to);
      return from && to ? [edgeIdentity({ from: edgeNode(from), to: edgeNode(to), kind: edge.type as "imports" | "calls", evidence: { source: "transient_source_analysis" } }, renames), edge] as const : undefined;
    })
    .filter((entry): entry is readonly [string, GraphEdge] => entry !== undefined));
  const afterEdges = new Map(after.graph.edges
    .filter((edge) => edge.type === "imports" || edge.type === "calls")
    .map((edge) => {
      const nodes = graphNodeById(after.graph);
      const from = nodes.get(edge.from);
      const to = nodes.get(edge.to);
      return from && to ? [edgeIdentity({ from: edgeNode(from), to: edgeNode(to), kind: edge.type as "imports" | "calls", evidence: { source: "transient_source_analysis" } }), edge] as const : undefined;
    })
    .filter((entry): entry is readonly [string, GraphEdge] => entry !== undefined));
  const beforeKeys = new Set(beforeEdges.keys());
  const afterKeys = new Set(afterEdges.keys());
  const added = structuralEdges(after.graph).filter((edge) => !beforeKeys.has(edgeIdentity(edge)));
  const removed = structuralEdges(before.graph).filter((edge) => !afterKeys.has(edgeIdentity(edge, renames)));
  const unchanged = [...afterKeys].filter((key) => beforeKeys.has(key)).length;
  const limit = maxEdges(input);
  const all = [...added.map((edge) => ["added", edge] as const), ...removed.map((edge) => ["removed", edge] as const)]
    .sort((left, right) => compareEdges(left[1], right[1]) || left[0].localeCompare(right[0]));
  const truncated = all.length > limit;
  const selected = all.slice(0, limit);
  const addedEdges = selected.filter(([kind]) => kind === "added").map(([, edge]) => edge);
  const removedEdges = selected.filter(([kind]) => kind === "removed").map(([, edge]) => edge);
  const reasons = truncated ? [`graph delta edges truncated at ${limit}; ${all.length - limit} omitted`] : [];
  const coverage = mergeResolutionCoverage(before.coverage, after.coverage);
  const diagnostics = createCoverageDiagnostics({
    resolutionCoverage: coverage,
    resolutionDiagnostics: [...before.diagnostics, ...after.diagnostics],
    change: {
      files: changes.files,
      reasons,
      mayBeIncomplete: truncated,
    },
  });
  return {
    source: changes.source,
    summary: {
      changedFiles: changes.files.length,
      addedEdges: addedEdges.length,
      removedEdges: removedEdges.length,
      unchangedRelevantEdges: unchanged,
    },
    changedFiles: changes.files,
    addedEdges,
    removedEdges,
    diagnostics,
    mayBeIncomplete: diagnostics.mayBeIncomplete,
    reasons: [...new Set([...reasons, ...diagnostics.reasons])],
  };
}
