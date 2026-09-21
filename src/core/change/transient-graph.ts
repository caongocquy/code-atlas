import { parseCodeSymbols } from "../graph/parsers/code-parser.js";
import type { CodeChunk } from "../graph/parsers/types.js";
import { getQualifiedSymbolName } from "../graph/build-graph.js";
import { createGraphNodeId } from "../graph/node-id.js";
import { extractImports, isRelativeImport, resolveImportCandidates } from "../graph/imports.js";
import { extractImportBindings } from "../graph/import-bindings.js";
import { extractCalls, hasParserErrors } from "../graph/calls.js";
import { resolveCallResults } from "../graph/call-resolution.js";
import { resolveMemberCallResults } from "../graph/member-resolution.js";
import type { ResolutionCoverage, ResolutionDiagnostic } from "../graph/resolution.types.js";
import { emptyResolutionCoverage, mergeResolutionCoverage } from "../graph/resolution.types.js";
import type { CodeGraph, GraphNode, GraphNodeType } from "../graph/types.js";
import type { GitSourceSnapshot } from "../../infrastructure/git/git-change-reader.js";

export type TransientGraph = {
  graph: CodeGraph;
  coverage: ResolutionCoverage;
  diagnostics: ResolutionDiagnostic[];
};

function graphType(type: string): GraphNodeType | undefined {
  return ["function", "class", "method", "variable", "interface", "type", "enum"].includes(type)
    ? type as GraphNodeType
    : undefined;
}

function sourceEntries(snapshot: GitSourceSnapshot): Array<[string, string]> {
  return [...snapshot.files.entries()]
    .filter(([, content]) => !content.includes(0))
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([file, content]) => [file, content.toString("utf8")]);
}

export function buildTransientGraph(snapshot: GitSourceSnapshot, repoId: string): TransientGraph {
  const entries = sourceEntries(snapshot);
  const fileSet = new Set(entries.map(([file]) => file));
  const graph: CodeGraph = { nodes: [], edges: [] };
  const sources = new Map(entries);
  const fileNodeIds = new Map<string, string>();
  const coverage = emptyResolutionCoverage();
  const diagnostics: ResolutionDiagnostic[] = [];

  for (const [file] of entries) {
    const id = createGraphNodeId(repoId, file, "file", file);
    fileNodeIds.set(file, id);
    graph.nodes.push({ id, type: "file", name: file, file });
  }

  for (const [file, source] of entries) {
    const fileNodeId = fileNodeIds.get(file);
    if (!fileNodeId) continue;
    const chunks = parseCodeSymbols(source, file);
    for (const chunk of chunks as CodeChunk[]) {
      const type = graphType(chunk.symbolType);
      if (!type) continue;
      const qualifiedName = getQualifiedSymbolName(chunk, chunks);
      const id = createGraphNodeId(repoId, file, type, qualifiedName);
      graph.nodes.push({ id, type, name: chunk.symbolName, qualifiedName, file, startLine: chunk.startLine, endLine: chunk.endLine });
      graph.edges.push({ from: fileNodeId, to: id, type: "contains" });
    }
  }

  for (const [file, source] of entries) {
    const importer = fileNodeIds.get(file);
    if (!importer) continue;
    for (const reference of extractImports(source)) {
      if (!isRelativeImport(reference.source)) continue;
      const targetFile = resolveImportCandidates(file, reference.source).find((candidate) => fileSet.has(candidate));
      const target = targetFile ? fileNodeIds.get(targetFile) : undefined;
      if (target) {
        graph.edges.push({ from: importer, to: target, type: "imports" });
      } else {
        const offset = source.indexOf(reference.source);
        const line = offset < 0 ? 1 : source.slice(0, offset).split(/\r?\n/).length;
        diagnostics.push({
          kind: "unresolved",
          evidence: [{ evidenceKind: "EXTRACTED", source: { file, line } }],
          reason: "broken internal import target is unavailable",
          source: { file, line },
        });
      }
    }
  }

  for (const [file, source] of entries) {
    const bindings = extractImportBindings(source, file, fileSet);
    const calls = extractCalls(source, file);
    const result = resolveCallResults(graph, file, calls, bindings);
    const memberResult = resolveMemberCallResults(graph, file, source, calls, bindings);
    graph.edges.push(...result.edges, ...memberResult.edges);
    Object.assign(coverage, mergeResolutionCoverage(coverage, mergeResolutionCoverage(result.coverage, memberResult.coverage)));
    diagnostics.push(
      ...result.results.filter((item): item is ResolutionDiagnostic => item.kind !== "resolved"),
      ...memberResult.results.filter((item): item is ResolutionDiagnostic => item.kind !== "resolved"),
    );
    if (hasParserErrors(source, file)) coverage.parserErrors += 1;
  }
  coverage.mayBeIncomplete = coverage.parserErrors > 0 || coverage.unsupportedDynamic > 0
    || coverage.unresolvedCalls > 0 || coverage.ambiguousCalls > 0
    || diagnostics.some((item) => item.kind === "unresolved" && item.reason.includes("broken internal import"));
  return { graph, coverage, diagnostics };
}

export function graphNodeById(graph: CodeGraph): Map<string, GraphNode> {
  return new Map(graph.nodes.map((node) => [node.id, node]));
}
