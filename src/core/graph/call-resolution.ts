import type { CallReference } from "./calls.js";
import type { ImportBinding } from "./import-bindings.js";
import { builtinModules } from "node:module";
import { isRelativeImport } from "./imports.js";
import {
  emptyResolutionCoverage,
  type ResolutionBatch,
  type ResolutionEvidence,
  type ResolutionResult,
} from "./resolution.types.js";
import type { CodeGraph, GraphEdge, GraphNode } from "./types.js";

const callableTypes = new Set(["function", "method", "variable"]);

function sortedNodes(nodes: GraphNode[]): GraphNode[] {
  return [...nodes].sort((left, right) => left.id.localeCompare(right.id));
}

function findCallerNodes(graph: CodeGraph, file: string, call: CallReference): GraphNode[] {
  if (!call.callerName || !call.callerType) return [];

  const qualified = call.callerQualifiedName
    ? graph.nodes.filter((node) => node.file === file && node.type === call.callerType && node.qualifiedName === call.callerQualifiedName)
    : [];

  return sortedNodes(qualified.length > 0 ? qualified : graph.nodes.filter(
    (node) => node.file === file && node.name === call.callerName && node.type === call.callerType,
  ));
}

function findImportedCalleeNodes(graph: CodeGraph, bindings: ImportBinding[]): GraphNode[] {
  const nodes = bindings.flatMap((binding) => binding.targetFile
    ? graph.nodes.filter((node) => node.file === binding.targetFile && node.name === binding.importedName && callableTypes.has(node.type))
    : []);
  return sortedNodes(nodes).filter((node, index, all) => all.findIndex((item) => item.id === node.id) === index);
}

function findLocalCalleeNodes(graph: CodeGraph, file: string, name: string): GraphNode[] {
  return sortedNodes(graph.nodes.filter((node) => node.file === file && node.name === name && callableTypes.has(node.type)));
}

function evidence(file: string, line: number, resolutionMethod?: ResolutionEvidence["resolutionMethod"]): ResolutionEvidence {
  return {
    evidenceKind: resolutionMethod ? "INFERRED" : "EXTRACTED",
    resolutionMethod,
    source: { file, line },
  };
}

function edgeFor(caller: GraphNode, callee: GraphNode, result: Extract<ResolutionResult, { kind: "resolved" }>): GraphEdge {
  return {
    from: caller.id,
    to: callee.id,
    type: "calls",
    resolutionMethod: result.resolutionMethod,
    evidenceKind: result.evidence[0]?.evidenceKind,
    confidence: result.confidence,
    resolutionSource: result.source,
  };
}

function isUnsupportedDynamic(name: string): boolean {
  return name.includes("[") || name.includes("]") || name.includes("?");
}

function unresolvedImportReason(bindings: ImportBinding[]): string {
  const sources = bindings.map((binding) => binding.source);
  const builtins = new Set([...builtinModules, ...builtinModules.map((name) => `node:${name}`)]);
  if (sources.length > 0 && sources.every((source) => builtins.has(source))) return "builtin dependency is not indexed";
  if (sources.length > 0 && sources.every((source) => !isRelativeImport(source))) return "external dependency is not indexed";
  if (sources.length > 0 && sources.every((source) => isRelativeImport(source))) return "broken internal import target is unavailable";
  return "import binding target is unavailable";
}

export function resolveCallResults(
  graph: CodeGraph,
  file: string,
  calls: CallReference[],
  bindings: ImportBinding[],
): ResolutionBatch {
  const coverage = emptyResolutionCoverage();
  const edges: GraphEdge[] = [];
  const results: ResolutionResult[] = [];
  const seen = new Set<string>();
  const bindingsByName = new Map<string, ImportBinding[]>();

  for (const binding of bindings) {
    const existing = bindingsByName.get(binding.localName) ?? [];
    existing.push(binding);
    bindingsByName.set(binding.localName, existing);
  }

  for (const call of calls) {
    if (call.calleeName.includes(".")) continue;

    coverage.calls += 1;
    const callers = findCallerNodes(graph, file, call);
    const baseEvidence = evidence(file, call.line);
    let result: ResolutionResult;

    if (callers.length !== 1) {
      result = callers.length > 1
        ? {
            kind: "ambiguous",
            candidates: callers.map((node) => node.id),
            evidence: [{ ...baseEvidence, evidenceKind: "AMBIGUOUS" }],
            ambiguityReason: "caller identity is not unique",
            source: { file, line: call.line },
          }
        : {
            kind: "unresolved",
            evidence: [baseEvidence],
            reason: "caller identity is unavailable",
            source: { file, line: call.line },
            unsupportedDynamic: isUnsupportedDynamic(call.calleeName),
          };
    } else {
      const caller = callers[0];
      const hasBinding = bindingsByName.has(call.calleeName);
      const candidates = hasBinding
        ? findImportedCalleeNodes(graph, bindingsByName.get(call.calleeName) ?? [])
        : findLocalCalleeNodes(graph, file, call.calleeName);
      const method = hasBinding ? "import_binding" : "same_file";

      if (candidates.length === 1 && candidates[0] && caller) {
        result = {
          kind: "resolved",
          targetSymbolId: candidates[0].id,
          candidateCount: candidates.length,
          evidence: [evidence(file, call.line, method)],
          resolutionMethod: method,
          confidence: 1,
          source: { file, line: call.line },
        };
        if (caller.id !== candidates[0].id) {
          const edge = edgeFor(caller, candidates[0], result);
          const key = [edge.from, edge.to, edge.type].join(":");
          if (!seen.has(key)) {
            seen.add(key);
            edges.push(edge);
          }
        }
      } else if (candidates.length > 1) {
        result = {
          kind: "ambiguous",
          candidates: candidates.map((node) => node.id),
          evidence: [{ ...baseEvidence, evidenceKind: "AMBIGUOUS" }],
          ambiguityReason: "callee identity is not unique",
          source: { file, line: call.line },
        };
      } else {
        result = {
          kind: "unresolved",
          evidence: [evidence(file, call.line, method)],
          reason: hasBinding ? unresolvedImportReason(bindingsByName.get(call.calleeName) ?? []) : "no unique same-file callee candidate",
          source: { file, line: call.line },
          unsupportedDynamic: isUnsupportedDynamic(call.calleeName),
        };
      }
    }

    if (result.kind === "resolved") coverage.resolvedCalls += 1;
    else if (result.kind === "ambiguous") coverage.ambiguousCalls += 1;
    else {
      coverage.unresolvedCalls += 1;
      if (result.unsupportedDynamic) coverage.unsupportedDynamic += 1;
    }
    results.push(result);
  }

  return { edges, results, coverage };
}

export function resolveCallEdges(
  graph: CodeGraph,
  file: string,
  calls: CallReference[],
  bindings: ImportBinding[],
): GraphEdge[] {
  return resolveCallResults(graph, file, calls, bindings).edges;
}
