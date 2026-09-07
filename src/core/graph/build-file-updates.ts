import fs from "node:fs/promises";
import path from "node:path";

import { parseCodeSymbols } from "./parsers/code-parser.js";
import { extractCalls, hasParserErrors } from "./calls.js";
import { resolveCallResults } from "./call-resolution.js";
import { factsCalls, factsImportBindings, getQualifiedSymbolName } from "./build-graph.js";
import { extractImportBindings } from "./import-bindings.js";
import {
  extractImports,
  isRelativeImport,
  resolveImportCandidates,
} from "./imports.js";
import { createGraphNodeId } from "./node-id.js";
import type {
  CodeGraph,
  GraphEdge,
  GraphNode,
  GraphNodeType,
} from "./types.js";
import { resolveMemberCallResults } from "./member-resolution.js";
import { extractExtendsFactEvidence, resolveExtendsResults } from "./extends.js";
import { emptyResolutionCoverage, mergeResolutionCoverage, type GraphResolutionFile } from "./resolution.types.js";
import type { ProgressReporter } from "../progress/progress.types.js";
import { codeChunksFromFacts, type IndexedSourceUnit } from "../indexing/indexing.types.js";

export type BuiltFileGraph = {
  file: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  resolution: GraphResolutionFile;
};

function toGraphNodeType(symbolType: string): GraphNodeType | undefined {
  switch (symbolType) {
    case "function":
    case "class":
    case "method":
    case "variable":
    case "interface":
    case "type":
    case "enum":
      return symbolType;

    default:
      return undefined;
  }
}

export async function buildFileGraphs(
  repoPath: string,
  repoId: string,
  files: string[],
  allRepoFiles: Set<string>,
  baseGraph: CodeGraph,
  reporter?: ProgressReporter,
): Promise<BuiltFileGraph[]> {
  return buildFileGraphsInternal(repoPath, repoId, files, allRepoFiles, baseGraph, reporter);
}

async function buildFileGraphsInternal(
  repoPath: string,
  repoId: string,
  files: string[],
  allRepoFiles: Set<string>,
  baseGraph: CodeGraph,
  reporter?: ProgressReporter,
  unitsByFile?: Map<string, IndexedSourceUnit>,
): Promise<BuiltFileGraph[]> {
  const results: BuiltFileGraph[] = [];

  //
  // Build all local nodes first so call resolution
  // can see symbols created by other impacted files.
  //

  const localGraphs = new Map<
    string,
    {
      source: string;
      facts?: IndexedSourceUnit;
      nodes: GraphNode[];
      edges: GraphEdge[];
      resolution?: GraphResolutionFile;
    }
  >();

  for (let index = 0; index < files.length; index += 1) {
    const relativePath = files[index];

    if (!relativePath) {
      continue;
    }

    const absolutePath = path.join(repoPath, relativePath);

    const indexedUnit = unitsByFile?.get(relativePath);
    const source = indexedUnit?.source ?? await fs.readFile(absolutePath, "utf8");

    const fileNodeId = createGraphNodeId(
      repoId,
      relativePath,
      "file",
      relativePath,
    );

    const fileNode: GraphNode = {
      id: fileNodeId,
      type: "file",
      name: relativePath,
      qualifiedName: relativePath,
      file: relativePath,
    };

    const nodes: GraphNode[] = [fileNode];

    const edges: GraphEdge[] = [];

    const chunks = indexedUnit ? codeChunksFromFacts(indexedUnit) : parseCodeSymbols(source, relativePath);

    for (const chunk of chunks) {
      const nodeType = toGraphNodeType(chunk.symbolType);

      if (!nodeType) {
        continue;
      }

      const qualifiedName = getQualifiedSymbolName(chunk, chunks);

      const symbolNodeId = createGraphNodeId(
        repoId,
        relativePath,
        nodeType,
        qualifiedName,
      );

      nodes.push({
        id: symbolNodeId,
        type: nodeType,
        name: chunk.symbolName,
        qualifiedName,
        file: relativePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      });

      edges.push({
        from: fileNodeId,
        to: symbolNodeId,
        type: "contains",
      });
    }

    localGraphs.set(relativePath, {
      source,
      facts: indexedUnit,
      nodes,
      edges,
    });

    reporter?.setProgress(index + 1, files.length);
  }

  //
  // Create a working graph:
  //
  // persisted unchanged graph
  // +
  // fresh nodes for impacted files.
  //

  const impactedSet = new Set(files);

  const workingGraph: CodeGraph = {
    nodes: baseGraph.nodes.filter((node) => !impactedSet.has(node.file)),
    edges: [],
  };

  workingGraph.nodes.push(
    ...Array.from(localGraphs.values()).flatMap((entry) => entry.nodes),
  );

  //
  // Build imports + calls for each impacted file.
  //

  for (const relativePath of files) {
    const local = localGraphs.get(relativePath);

    if (!local) {
      continue;
    }

    const fileNode = local.nodes.find((node) => node.type === "file");

    if (!fileNode) {
      continue;
    }

    //
    // Imports.
    //

    const imports = local.facts
      ? local.facts.facts.imports.map((entry) => ({ source: entry.moduleSpecifier }))
      : extractImports(local.source);
    const seenImportSources = new Set<string>();

    for (const importReference of imports) {
      if (seenImportSources.has(importReference.source)) continue;
      seenImportSources.add(importReference.source);
      if (!isRelativeImport(importReference.source)) {
        continue;
      }

      const candidates = resolveImportCandidates(
        relativePath,
        importReference.source,
      );

      const targetFile = candidates.find((candidate) =>
        allRepoFiles.has(candidate),
      );

      if (!targetFile) {
        continue;
      }

      const targetNode = workingGraph.nodes.find(
        (node) => node.type === "file" && node.file === targetFile,
      );

      if (!targetNode) {
        continue;
      }

      local.edges.push({
        from: fileNode.id,
        to: targetNode.id,
        type: "imports",
      });
    }

    //
    // Calls.
    //

    const bindings = local.facts
      ? factsImportBindings(local.facts, allRepoFiles)
      : extractImportBindings(local.source, relativePath, allRepoFiles);

    const calls = local.facts
      ? factsCalls(local.facts, codeChunksFromFacts(local.facts))
      : extractCalls(local.source, relativePath);

    const temporaryGraph: CodeGraph = {
      nodes: workingGraph.nodes,
      edges: local.edges,
    };

    const callResults = resolveCallResults(
      temporaryGraph,
      relativePath,
      calls,
      bindings,
    );

    const memberResults = calls.some((call) => call.calleeName.includes("."))
      ? resolveMemberCallResults(temporaryGraph, relativePath, local.source, calls, bindings, true)
      : { edges: [], results: [], coverage: emptyResolutionCoverage() };

    const extendsResults = /\bextends\b/.test(local.source)
      ? resolveExtendsResults(workingGraph, relativePath, local.source, bindings, extractExtendsFactEvidence(local.source))
      : { edges: [], results: [], coverage: emptyResolutionCoverage() };
    local.edges.push(...callResults.edges, ...memberResults.edges, ...extendsResults.edges);
    const coverage = mergeResolutionCoverage(
      mergeResolutionCoverage(callResults.coverage, memberResults.coverage),
      extendsResults.coverage,
    );
    coverage.parserErrors = local.facts
      ? local.facts.facts.parseStatus === "deterministic_partial" ? 1 : 0
      : hasParserErrors(local.source, relativePath) ? 1 : 0;
    coverage.mayBeIncomplete = coverage.parserErrors > 0 || coverage.unsupportedDynamic > 0 || coverage.unresolvedCalls > 0 || coverage.ambiguousCalls > 0 || coverage.unresolvedExtends > 0 || coverage.ambiguousExtends > 0;
    local.resolution = {
      coverage,
      diagnostics: [...callResults.results, ...memberResults.results, ...extendsResults.results]
        .filter((result): result is Exclude<typeof result, { kind: "resolved" }> => result.kind !== "resolved"),
    };

    results.push({
      file: relativePath,
      nodes: local.nodes,
      edges: local.edges,
      resolution: local.resolution ?? { coverage: mergeResolutionCoverage(mergeResolutionCoverage(callResults.coverage, memberResults.coverage), extendsResults.coverage), diagnostics: [] },
    });
  }

  return results;
}

export async function buildFileGraphsFromFacts(
  repoPath: string,
  repoId: string,
  units: IndexedSourceUnit[],
  allRepoFiles: Set<string>,
  baseGraph: CodeGraph,
  reporter?: ProgressReporter,
): Promise<BuiltFileGraph[]> {
  return buildFileGraphsInternal(
    repoPath,
    repoId,
    units.map((unit) => unit.relativePath),
    allRepoFiles,
    baseGraph,
    reporter,
    new Map(units.map((unit) => [unit.relativePath, unit])),
  );
}
