import { log } from "@clack/prompts";
import { buildCodeGraph } from "../../core/graph/build-graph.js";
import type { GraphEdge, GraphNode } from "../../core/graph/types.js";

function createNodeMap(nodes: GraphNode[]): Map<string, GraphNode> {
  return new Map(nodes.map((node) => [node.id, node]));
}

function describeNode(node: GraphNode): string {
  if (node.type === "file") {
    return node.file;
  }

  return [node.file, `${node.type}:${node.name}`].join(" :: ");
}

function describeEdge(
  edge: GraphEdge,
  nodeById: Map<string, GraphNode>,
): string {
  const from = nodeById.get(edge.from);

  const to = nodeById.get(edge.to);

  if (!from || !to) {
    return `${edge.from} --${edge.type}--> ${edge.to}`;
  }

  return [describeNode(from), `--${edge.type}-->`, describeNode(to)].join(" ");
}

async function main(): Promise<void> {
  const repoPath = process.argv[2] ?? ".";

  const graph = await buildCodeGraph(repoPath);

  const nodeById = createNodeMap(graph.nodes);

  const fileNodes = graph.nodes.filter((node) => node.type === "file");

  const symbolNodes = graph.nodes.filter((node) => node.type !== "file");

  const containsEdges = graph.edges.filter((edge) => edge.type === "contains");

  const importEdges = graph.edges.filter((edge) => edge.type === "imports");

  const callEdges = graph.edges.filter((edge) => edge.type === "calls");

  log.message(`Nodes: ${graph.nodes.length}`);

  log.message(`- Files: ${fileNodes.length}`);

  log.message(`- Symbols: ${symbolNodes.length}`);

  log.message(`Edges: ${graph.edges.length}`);

  log.message(`- Contains: ${containsEdges.length}`);

  log.message(`- Imports: ${importEdges.length}`);

  log.message(`- Calls: ${callEdges.length}`);

  log.message("\nSample nodes:");

  for (const node of graph.nodes.slice(0, 10)) {
    log.message(describeNode(node));
  }

  log.message("\nSample contains edges:");

  for (const edge of containsEdges.slice(0, 15)) {
    log.message(describeEdge(edge, nodeById));
  }

  log.message("\nSample import edges:");

  for (const edge of importEdges.slice(0, 20)) {
    log.message(describeEdge(edge, nodeById));
  }

  log.message("\nSample call edges:");

  for (const edge of callEdges.slice(0, 20)) {
    log.message(describeEdge(edge, nodeById));
  }
}

main().catch((error) => {
  log.error(error);
  process.exit(1);
});
