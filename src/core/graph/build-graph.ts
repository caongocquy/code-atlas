import fs from "node:fs/promises";
import path from "node:path";

import { parseCodeSymbols } from "./parsers/code-parser.js";
import { getRepoId, scanRepo } from "../repository/repository-files.js";
import { canonicalRepositoryPath } from "../repository/repository-identity.js";
import {
  extractImports,
  isRelativeImport,
  resolveImportCandidates,
} from "./imports.js";
import { createGraphNodeId } from "./node-id.js";
import type { CodeGraph, GraphNodeType } from "./types.js";
import { extractImportBindings } from "./import-bindings.js";
import { extractCalls, hasParserErrors } from "./calls.js";
import { resolveCallResults } from "./call-resolution.js";
import { resolveMemberCallResults } from "./member-resolution.js";
import { resolveExtendsResults } from "./extends.js";
import { mergeResolutionCoverage, type GraphResolutionFile } from "./resolution.types.js";
import type { ProgressReporter } from "../progress/progress.types.js";

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

type QualifiedChunk = {
  symbolName: string;
  symbolType: string;
  startLine: number;
  endLine: number;
  startColumn?: number;
  endColumn?: number;
};

function canOwnSymbol(symbolType: string): boolean {
  return (
    symbolType === "class" ||
    symbolType === "function" ||
    symbolType === "method" ||
    symbolType === "variable"
  );
}

function findDirectOwner(
  chunk: QualifiedChunk,
  chunks: QualifiedChunk[],
): QualifiedChunk | undefined {
  const owners = chunks.filter(
    (candidate) =>
      candidate !== chunk &&
      canOwnSymbol(candidate.symbolType) &&
      candidate.startLine <= chunk.startLine &&
      candidate.endLine >= chunk.endLine &&
      (candidate.startLine < chunk.startLine ||
        (candidate.startLine === chunk.startLine &&
          (candidate.startColumn ?? 0) <= (chunk.startColumn ?? 0))) &&
      (candidate.endLine > chunk.endLine ||
        (candidate.endLine === chunk.endLine &&
          (candidate.endColumn ?? Number.MAX_SAFE_INTEGER) >=
            (chunk.endColumn ?? Number.MIN_SAFE_INTEGER))),
  );

  if (owners.length === 0) {
    return undefined;
  }

  //
  // The smallest containing symbol is the direct owner.
  //

  return owners.sort((a, b) => {
    const aSize = a.endLine - a.startLine;

    const bSize = b.endLine - b.startLine;

    return aSize - bSize;
  })[0];
}

function buildQualifiedName(
  chunk: QualifiedChunk,
  chunks: QualifiedChunk[],
  visited: Set<QualifiedChunk>,
): string {
  if (visited.has(chunk)) {
    return chunk.symbolName;
  }

  visited.add(chunk);

  const owner = findDirectOwner(chunk, chunks);

  if (!owner) {
    return chunk.symbolName;
  }

  const ownerName = buildQualifiedName(owner, chunks, visited);

  return `${ownerName}.${chunk.symbolName}`;
}

export function getQualifiedSymbolName(
  chunk: QualifiedChunk,
  chunks: QualifiedChunk[],
): string {
  return buildQualifiedName(chunk, chunks, new Set());
}

export type GraphBuildResult = {
  graph: CodeGraph;
  resolutionByFile: Map<string, GraphResolutionFile>;
};

export async function buildCodeGraphWithResolution(
  repoPath: string,
  reporter?: ProgressReporter,
  repositoryId?: string,
  sourceFiles?: string[],
): Promise<GraphBuildResult> {
  const absoluteRepoPath = canonicalRepositoryPath(path.resolve(repoPath));

  const repoId = repositoryId ?? getRepoId(absoluteRepoPath);

  const files = sourceFiles ?? await scanRepo(absoluteRepoPath);

  const relativeFiles = files.map((filePath) =>
    path.relative(absoluteRepoPath, filePath),
  );

  const fileSet = new Set(relativeFiles);

  const graph: CodeGraph = {
    nodes: [],
    edges: [],
  };
  const resolutionByFile = new Map<string, GraphResolutionFile>();

  const fileNodeIds = new Map<string, string>();

  //
  // Pass 1:
  // Build file nodes.
  //

  for (const relativePath of relativeFiles) {
    const fileNodeId = createGraphNodeId(
      repoId,
      relativePath,
      "file",
      relativePath,
    );

    fileNodeIds.set(relativePath, fileNodeId);

    graph.nodes.push({
      id: fileNodeId,
      type: "file",
      name: relativePath,
      file: relativePath,
    });
  }

  //
  // Pass 2:
  // Build symbol nodes + contains edges.
  //

  for (let index = 0; index < files.length; index += 1) {
    const filePath = files[index];

    if (!filePath) {
      continue;
    }

    const relativePath = path.relative(absoluteRepoPath, filePath);

    const fileNodeId = fileNodeIds.get(relativePath);

    if (!fileNodeId) {
      continue;
    }

    const source = await fs.readFile(filePath, "utf8");

    const chunks = parseCodeSymbols(source, relativePath);

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

      graph.nodes.push({
        id: symbolNodeId,
        type: nodeType,
        name: chunk.symbolName,
        qualifiedName,
        file: relativePath,
        startLine: chunk.startLine,
        endLine: chunk.endLine,
      });

      graph.edges.push({
        from: fileNodeId,
        to: symbolNodeId,
        type: "contains",
      });
    }

    reporter?.setProgress(index + 1, files.length);
  }

  //
  // Pass 3:
  // Build import edges.
  //

  for (const filePath of files) {
    const relativePath = path.relative(absoluteRepoPath, filePath);

    const importerNodeId = fileNodeIds.get(relativePath);

    if (!importerNodeId) {
      continue;
    }

    const source = await fs.readFile(filePath, "utf8");

    const imports = extractImports(source);

    for (const importReference of imports) {
      if (!isRelativeImport(importReference.source)) {
        continue;
      }

      const candidates = resolveImportCandidates(
        relativePath,
        importReference.source,
      );

      const targetFile = candidates.find((candidate) => fileSet.has(candidate));

      if (!targetFile) {
        continue;
      }

      const targetNodeId = fileNodeIds.get(targetFile);

      if (!targetNodeId) {
        continue;
      }

      graph.edges.push({
        from: importerNodeId,
        to: targetNodeId,
        type: "imports",
      });
    }
  }
  //
  // Pass 4:
  // Build call edges.
  //

  for (const filePath of files) {
    const relativePath = path.relative(absoluteRepoPath, filePath);

    const source = await fs.readFile(filePath, "utf8");

    const bindings = extractImportBindings(source, relativePath, fileSet);

    const calls = extractCalls(source, relativePath);

    const callResults = resolveCallResults(graph, relativePath, calls, bindings);
    const memberResults = resolveMemberCallResults(
      graph,
      relativePath,
      source,
      calls,
      bindings,
    );

    const extendsResults = resolveExtendsResults(graph, relativePath, source, bindings);
    graph.edges.push(...callResults.edges, ...memberResults.edges, ...extendsResults.edges);
    const coverage = mergeResolutionCoverage(
      mergeResolutionCoverage(callResults.coverage, memberResults.coverage),
      extendsResults.coverage,
    );
    coverage.parserErrors = hasParserErrors(source, relativePath) ? 1 : 0;
    coverage.mayBeIncomplete = coverage.parserErrors > 0 || coverage.unsupportedDynamic > 0;
    resolutionByFile.set(relativePath, {
      coverage,
      diagnostics: [...callResults.results, ...memberResults.results, ...extendsResults.results]
        .filter((result): result is Exclude<typeof result, { kind: "resolved" }> => result.kind !== "resolved"),
    });
  }
  return { graph, resolutionByFile };
}

export async function buildCodeGraph(
  repoPath: string,
  reporter?: ProgressReporter,
  repositoryId?: string,
  sourceFiles?: string[],
): Promise<CodeGraph> {
  return (await buildCodeGraphWithResolution(repoPath, reporter, repositoryId, sourceFiles)).graph;
}
