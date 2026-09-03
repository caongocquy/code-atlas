import type { CodeGraph, GraphEdge, GraphNode } from "./types.js";
import type { CallReference } from "./calls.js";
import type { ImportBinding } from "./import-bindings.js";

function findCallerNode(
  graph: CodeGraph,
  file: string,
  call: CallReference,
): GraphNode | undefined {
  if (!call.callerName || !call.callerType) {
    return undefined;
  }

  if (call.callerQualifiedName) {
    const qualifiedMatch = graph.nodes.find(
      (node) =>
        node.file === file &&
        node.type === call.callerType &&
        node.qualifiedName === call.callerQualifiedName,
    );

    if (qualifiedMatch) {
      return qualifiedMatch;
    }
  }

  return graph.nodes.find(
    (node) =>
      node.file === file &&
      node.name === call.callerName &&
      node.type === call.callerType,
  );
}

function findImportedCalleeNode(
  graph: CodeGraph,
  binding: ImportBinding,
): GraphNode | undefined {
  if (!binding.targetFile) {
    return undefined;
  }

  return graph.nodes.find(
    (node) =>
      node.file === binding.targetFile &&
      node.name === binding.importedName &&
      (node.type === "function" ||
        node.type === "method" ||
        node.type === "variable"),
  );
}

function findLocalCalleeNode(
  graph: CodeGraph,
  file: string,
  calleeName: string,
): GraphNode | undefined {
  return graph.nodes.find(
    (node) =>
      node.file === file &&
      node.name === calleeName &&
      (node.type === "function" ||
        node.type === "method" ||
        node.type === "variable"),
  );
}

function createEdgeKey(edge: GraphEdge): string {
  return [edge.from, edge.to, edge.type].join(":");
}

export function resolveCallEdges(
  graph: CodeGraph,
  file: string,
  calls: CallReference[],
  bindings: ImportBinding[],
): GraphEdge[] {
  const edges: GraphEdge[] = [];

  const seen = new Set<string>();

  const bindingByLocalName = new Map(
    bindings.map((binding) => [binding.localName, binding]),
  );

  for (const call of calls) {
    if (call.calleeName.includes(".")) {
      continue;
    }

    const callerNode = findCallerNode(graph, file, call);

    if (!callerNode) {
      continue;
    }

    let calleeNode: GraphNode | undefined;

    const binding = bindingByLocalName.get(call.calleeName);

    if (binding) {
      calleeNode = findImportedCalleeNode(graph, binding);
    }

    if (!calleeNode) {
      calleeNode = findLocalCalleeNode(graph, file, call.calleeName);
    }

    if (!calleeNode) {
      continue;
    }

    if (callerNode.id === calleeNode.id) {
      continue;
    }

    const edge: GraphEdge = {
      from: callerNode.id,
      to: calleeNode.id,
      type: "calls",
    };

    const edgeKey = createEdgeKey(edge);

    if (seen.has(edgeKey)) {
      continue;
    }

    seen.add(edgeKey);
    edges.push(edge);
  }

  return edges;
}
