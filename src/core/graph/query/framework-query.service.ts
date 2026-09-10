import { frameworkEntityKey, frameworkSubjectKey } from "../../framework/framework-identity.js";
import type { FrameworkSnapshot, FrameworkSubjectRef } from "../../framework/framework.types.js";
import type { CodeGraph, GraphNode } from "../types.js";
import type { FrameworkQueryEdge, FrameworkQueryNode, FrameworkQueryProjection } from "./framework-query.types.js";

export function projectFrameworkGraph(graph: CodeGraph, snapshot: FrameworkSnapshot | undefined): FrameworkQueryProjection {
  const nodes: FrameworkQueryNode[] = graph.nodes.map((node) => ({ kind: "language", node }));
  const edges: FrameworkQueryEdge[] = graph.edges.map((edge) => ({ kind: "language", edge }));
  if (!snapshot) return { nodes, edges, classifications: [], diagnostics: [], coverage: [], mayBeIncomplete: true };
  const frameworkNodes = new Map(snapshot.entities.map((entity) => [frameworkEntityKey(entity.ref), { kind: "framework" as const, entity }]));
  nodes.push(...[...frameworkNodes.values()]);
  edges.push(...snapshot.relationships.map((relationship) => ({ kind: "framework" as const, relationship })));
  return { nodes: nodes.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))), edges: edges.sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))), classifications: snapshot.classifications, diagnostics: snapshot.diagnostics, coverage: snapshot.coverage, mayBeIncomplete: snapshot.detections.some((item) => !item.complete) || snapshot.config.some((item) => !item.complete) };
}

function subjectKey(subject: FrameworkSubjectRef): string {
  return frameworkSubjectKey(subject);
}

export function queryFrameworkProjection(projection: FrameworkQueryProjection, subject: FrameworkSubjectRef, depth: number): FrameworkQueryProjection {
  if (!Number.isInteger(depth) || depth < 0 || depth > 8) throw new RangeError("Framework query depth must be an integer from 0 through 8");
  const root = subjectKey(subject);
  const languageNodes = new Map(projection.nodes.filter((node): node is Extract<FrameworkQueryNode, { kind: "language" }> => node.kind === "language").map((node) => [node.node.id, node]));
  const frameworkNodes = new Map(projection.nodes.filter((node): node is Extract<FrameworkQueryNode, { kind: "framework" }> => node.kind === "framework").map((node) => [frameworkEntityKey(node.entity.ref), node]));
  const seen = new Set([root]);
  let frontier = new Set([root]);
  const selectedEdges: FrameworkQueryEdge[] = [];
  for (let level = 0; level < depth; level += 1) {
    const next = new Set<string>();
    for (const edge of projection.edges) {
      const key = edge.kind === "language" ? edge.edge.from : subjectKey(edge.relationship.source);
      const target = edge.kind === "language" ? edge.edge.to : subjectKey(edge.relationship.target);
      if (!frontier.has(key) || selectedEdges.some((item) => JSON.stringify(item) === JSON.stringify(edge))) continue;
      selectedEdges.push(edge);
      if (!seen.has(target)) { seen.add(target); next.add(target); }
    }
    frontier = next;
  }
  const nodes = [...seen].flatMap((key) => languageNodes.get(key) ?? frameworkNodes.get(key) ?? []).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
  const classifications = projection.classifications.filter((item) => seen.has(subjectKey(item.subject)));
  return { nodes, edges: selectedEdges, classifications, diagnostics: projection.diagnostics, coverage: projection.coverage, mayBeIncomplete: projection.mayBeIncomplete };
}
