import Parser from "tree-sitter";

import { getLanguageAdapter } from "./parsers/registry.js";
import type { ImportBinding } from "./import-bindings.js";
import {
  emptyResolutionCoverage,
  type ResolutionBatch,
  type ResolutionEvidence,
  type ResolutionResult,
} from "./resolution.types.js";
import type { CodeGraph, GraphEdge, GraphNode } from "./types.js";

function createParser(filePath: string): Parser | undefined {
  const adapter = getLanguageAdapter(filePath);
  if (!adapter) return undefined;
  const parser = new Parser();
  parser.setLanguage(adapter.grammar);
  return parser;
}

function findNodes(graph: CodeGraph, file: string, name: string): GraphNode[] {
  return graph.nodes.filter((node) => node.file === file && node.type === "class" && node.name === name)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function parentName(classNode: Parser.SyntaxNode): string | undefined {
  const heritage = classNode.namedChildren.find((child) => child.type === "class_heritage");
  const clause = heritage?.namedChildren.find((child) => child.type === "extends_clause");
  const value = clause?.childForFieldName("value");
  return value?.type === "identifier" || value?.type === "type_identifier" ? value.text : undefined;
}

function importsByName(bindings: ImportBinding[]): Map<string, ImportBinding[]> {
  const result = new Map<string, ImportBinding[]>();
  for (const binding of bindings) result.set(binding.localName, [...(result.get(binding.localName) ?? []), binding]);
  return result;
}

export function resolveExtendsResults(
  graph: CodeGraph,
  file: string,
  source: string,
  importBindings: ImportBinding[],
): ResolutionBatch {
  const parser = createParser(file);
  const coverage = emptyResolutionCoverage();
  if (!parser) return { edges: [], results: [], coverage };
  const imports = importsByName(importBindings);
  const edges: GraphEdge[] = [];
  const results: ResolutionResult[] = [];
  const tree = parser.parse(source);
  const seen = new Set<string>();

  function walk(node: Parser.SyntaxNode): void {
    if (node.type === "class_declaration") {
      const childName = node.childForFieldName("name")?.text;
      const targetName = parentName(node);
      if (childName && targetName) {
        coverage.extends += 1;
        const line = node.startPosition.row + 1;
        const childCandidates = findNodes(graph, file, childName);
        const bindings = imports.get(targetName);
        const parentCandidates = bindings
          ? bindings.flatMap((binding) => binding.targetFile ? findNodes(graph, binding.targetFile, binding.importedName) : [])
          : findNodes(graph, file, targetName);
        const candidates = parentCandidates.filter((candidate, index, all) => all.findIndex((item) => item.id === candidate.id) === index).sort((left, right) => left.id.localeCompare(right.id));
        let result: ResolutionResult;
        if (childCandidates.length !== 1) {
          result = childCandidates.length > 1
            ? { kind: "ambiguous", candidates: childCandidates.map((candidate) => candidate.id), evidence: [{ evidenceKind: "AMBIGUOUS", source: { file, line } }], ambiguityReason: "child class identity is not unique", source: { file, line } }
            : { kind: "unresolved", evidence: [{ evidenceKind: "EXTRACTED", source: { file, line } }], reason: "child class identity is unavailable", source: { file, line } };
        } else if (candidates.length === 1 && candidates[0]) {
          const method = "inheritance" as const;
          result = { kind: "resolved", targetSymbolId: candidates[0].id, evidence: [{ evidenceKind: "INFERRED", resolutionMethod: method, source: { file, line } }], resolutionMethod: method, confidence: 1, source: { file, line } };
          const child = childCandidates[0];
          const edge = { from: child.id, to: candidates[0].id, type: "extends" as const, resolutionMethod: method, evidenceKind: "INFERRED" as const, confidence: 1, resolutionSource: { file, line } };
          const key = [edge.from, edge.to, edge.type].join(":");
          if (!seen.has(key)) { seen.add(key); edges.push(edge); }
        } else if (candidates.length > 1) {
          result = { kind: "ambiguous", candidates: candidates.map((candidate) => candidate.id), evidence: [{ evidenceKind: "AMBIGUOUS", source: { file, line } }], ambiguityReason: "parent class identity is not unique", source: { file, line } };
        } else {
          result = { kind: "unresolved", evidence: [{ evidenceKind: "INFERRED", resolutionMethod: "inheritance", source: { file, line } }], reason: "no unique parent class candidate", source: { file, line } };
        }
        if (result.kind === "resolved") coverage.resolvedExtends += 1;
        else if (result.kind === "ambiguous") coverage.ambiguousExtends += 1;
        else coverage.unresolvedExtends += 1;
        results.push(result);
      }
    }
    for (const child of node.namedChildren) walk(child);
  }
  walk(tree.rootNode);
  return { edges, results, coverage };
}

export function resolveExtendsEdges(
  graph: CodeGraph,
  file: string,
  source: string,
  importBindings: ImportBinding[],
): GraphEdge[] {
  return resolveExtendsResults(graph, file, source, importBindings).edges;
}
