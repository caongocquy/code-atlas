import fs from "node:fs/promises";
import path from "node:path";

import { parseCodeSymbols } from "../parsers/code-parser.js";
import { extractCalls } from "./calls.js";
import { resolveCallEdges } from "./call-resolution.js";
import { getQualifiedSymbolName } from "./build-graph.js";
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
import { resolveMemberCallEdges } from "./member-resolution.js";
import { resolveExtendsEdges } from "./extends.js";
import type { ProgressReporter } from "../cli/types.js";

export type BuiltFileGraph = {
  file: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
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
  const results: BuiltFileGraph[] = [];

  //
  // Build all local nodes first so call resolution
  // can see symbols created by other impacted files.
  //

  const localGraphs = new Map<
    string,
    {
      source: string;
      nodes: GraphNode[];
      edges: GraphEdge[];
    }
  >();

  for (let index = 0; index < files.length; index += 1) {
    const relativePath = files[index];

    if (!relativePath) {
      continue;
    }

    const absolutePath = path.join(repoPath, relativePath);

    const source = await fs.readFile(absolutePath, "utf8");

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

    const imports = extractImports(local.source);

    for (const importReference of imports) {
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

    const bindings = extractImportBindings(
      local.source,
      relativePath,
      allRepoFiles,
    );

    const calls = extractCalls(local.source, relativePath);

    const temporaryGraph: CodeGraph = {
      nodes: workingGraph.nodes,
      edges: local.edges,
    };

    const callEdges = resolveCallEdges(
      temporaryGraph,
      relativePath,
      calls,
      bindings,
    );

    local.edges.push(...callEdges);
    const memberCallEdges = resolveMemberCallEdges(
      temporaryGraph,
      relativePath,
      local.source,
      calls,
      bindings,
    );

    local.edges.push(...memberCallEdges);

    local.edges.push(
      ...resolveExtendsEdges(workingGraph, relativePath, local.source, bindings),
    );

    results.push({
      file: relativePath,
      nodes: local.nodes,
      edges: local.edges,
    });
  }

  return results;
}
