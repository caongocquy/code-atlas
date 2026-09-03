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

  console.log(`Nodes: ${graph.nodes.length}`);

  console.log(`- Files: ${fileNodes.length}`);

  console.log(`- Symbols: ${symbolNodes.length}`);

  console.log(`Edges: ${graph.edges.length}`);

  console.log(`- Contains: ${containsEdges.length}`);

  console.log(`- Imports: ${importEdges.length}`);

  console.log(`- Calls: ${callEdges.length}`);

  console.log("\nSample nodes:");

  for (const node of graph.nodes.slice(0, 10)) {
    console.log(describeNode(node));
  }

  console.log("\nSample contains edges:");

  for (const edge of containsEdges.slice(0, 15)) {
    console.log(describeEdge(edge, nodeById));
  }

  console.log("\nSample import edges:");

  for (const edge of importEdges.slice(0, 20)) {
    console.log(describeEdge(edge, nodeById));
  }

  console.log("\nSample call edges:");

  for (const edge of callEdges.slice(0, 20)) {
    console.log(describeEdge(edge, nodeById));
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
