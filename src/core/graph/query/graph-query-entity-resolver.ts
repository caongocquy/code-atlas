import type { CodeGraph, GraphNode } from "../types.js";
import type {
  GraphEntityMatch,
  GraphEntityMatchReason,
  GraphEntityResolution,
} from "./graph-query.types.js";

function normalizeIdentifier(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_./\\:#$-]+/g, " ")
    .replace(/[^a-zA-Z0-9 ]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, " ");
}

function nodeKey(node: GraphNode): string {
  return [node.file, node.type, node.qualifiedName ?? node.name, node.id].join(":");
}

function pathKey(value: string): string {
  return value.replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
}

function splitFileContext(query: string): { file: string; symbol: string } | undefined {
  const separator = query.lastIndexOf(":");

  if (separator <= 0 || !query.slice(0, separator).includes("/")) {
    return undefined;
  }

  return {
    file: query.slice(0, separator),
    symbol: query.slice(separator + 1),
  };
}

function matchNode(
  node: GraphNode,
  query: string,
  fileContext?: { file: string; symbol: string },
): { reason: GraphEntityMatchReason; score: number } | undefined {
  const name = node.name.toLowerCase();
  const qualifiedName = (node.qualifiedName ?? "").toLowerCase();
  const file = pathKey(node.file);
  const normalizedQuery = normalizeIdentifier(query);
  const normalizedName = normalizeIdentifier(node.name);
  const normalizedQualifiedName = normalizeIdentifier(node.qualifiedName ?? "");

  if (fileContext) {
    const contextFile = pathKey(fileContext.file);
    const contextSymbol = fileContext.symbol.toLowerCase();

    if (file !== contextFile) {
      return undefined;
    }

    if (qualifiedName === contextSymbol || name === contextSymbol) {
      return { reason: "file_path_context", score: 1_200 };
    }

    if (
      normalizeIdentifier(node.name) === normalizeIdentifier(fileContext.symbol) ||
      normalizeIdentifier(node.qualifiedName ?? "") === normalizeIdentifier(fileContext.symbol)
    ) {
      return { reason: "file_path_context", score: 1_100 };
    }

    if (name.startsWith(contextSymbol) || qualifiedName.startsWith(contextSymbol)) {
      return { reason: "prefix", score: 700 };
    }

    return undefined;
  }

  const lowerQuery = query.toLowerCase();

  if (qualifiedName === lowerQuery) {
    return { reason: "exact_qualified_name", score: 1_000 };
  }

  if (name === lowerQuery) {
    return { reason: "exact_symbol_name", score: 900 };
  }

  if (normalizedQuery && (normalizedName === normalizedQuery || normalizedQualifiedName === normalizedQuery)) {
    return { reason: "exact_normalized_token", score: 800 };
  }

  if (file === pathKey(query)) {
    return node.type === "file"
      ? { reason: "file_path_context", score: 950 }
      : { reason: "file_path_context", score: 650 };
  }

  if (name.startsWith(lowerQuery) || qualifiedName.startsWith(lowerQuery)) {
    return { reason: "prefix", score: 500 };
  }

  if (name.includes(lowerQuery) || qualifiedName.includes(lowerQuery) || file.includes(pathKey(query))) {
    return { reason: "lexical_relevance", score: 300 };
  }

  return undefined;
}

function candidateComparator(left: GraphEntityMatch, right: GraphEntityMatch): number {
  return right.score - left.score || nodeKey(left.entity).localeCompare(nodeKey(right.entity));
}

export class GraphQueryEntityResolver {
  constructor(private readonly graph: CodeGraph) {}

  resolve(query: string): GraphEntityResolution {
    const trimmed = query.trim();

    if (!trimmed) {
      return { status: "not_found", query, candidates: [] };
    }

    const fileContext = splitFileContext(trimmed);
    const lookupQuery = fileContext?.symbol ?? trimmed;
    const candidates = this.graph.nodes
      .map((entity) => {
        const match = matchNode(entity, lookupQuery, fileContext);
        return match ? { entity, ...match, rank: 0 } : undefined;
      })
      .filter((candidate): candidate is Omit<GraphEntityMatch, "rank"> & { rank: number } => candidate !== undefined)
      .sort(candidateComparator)
      .map((candidate, index) => ({ ...candidate, rank: index + 1 }));

    if (candidates.length === 0) {
      return { status: "not_found", query, candidates: [] };
    }

    const topScore = candidates[0]?.score ?? 0;
    const topCandidates = candidates.filter((candidate) => candidate.score === topScore);

    if (topCandidates.length > 1) {
      return { status: "ambiguous", query, candidates };
    }

    return {
      status: "resolved",
      query,
      entity: candidates[0]!.entity,
      candidates,
    };
  }
}

export function resolveGraphEntity(
  graph: CodeGraph,
  query: string,
): GraphEntityResolution {
  return new GraphQueryEntityResolver(graph).resolve(query);
}
