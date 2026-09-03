import path from "node:path";

import {
  findCallees,
  findCallers,
  findImportedBy,
  findImports,
  type GraphQueryResult,
} from "../../core/graph/query.js";
import { AtlasStore } from "../../storage/atlas/atlas.store.js";
import type { GraphNode } from "../../core/graph/types.js";
import { getRepositoryIdentity } from "../../core/repository/repository-identity.js";

function describeNode(node: GraphNode): string {
  if (node.type === "file") {
    return node.file;
  }

  return `${node.file} :: ${node.type}:${node.name}`;
}

function printResults(results: GraphQueryResult[]): void {
  if (results.length === 0) {
    console.log("No graph results found");

    return;
  }

  for (const result of results) {
    console.log(`\n${describeNode(result.source)}`);

    if (result.targets.length === 0) {
      console.log("  (no matches)");

      continue;
    }

    for (const target of result.targets) {
      console.log(`  → ${describeNode(target)}`);
    }
  }
}

async function main(): Promise<void> {
  const [command, value] = process.argv.slice(2);

  if (!command || !value) {
    throw new Error(
      [
        "Usage:",
        "pnpm exec tsx src/adapters/cli/query-graph.command.ts callers <symbol>",
        "pnpm exec tsx src/adapters/cli/query-graph.command.ts callees <symbol>",
        "pnpm exec tsx src/adapters/cli/query-graph.command.ts imports <file>",
        "pnpm exec tsx src/adapters/cli/query-graph.command.ts imported-by <file>",
      ].join("\n"),
    );
  }

  const repoPath = path.resolve(".");

  const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
  const repoId = store.ensureRepository(getRepositoryIdentity(repoPath)).id;

  try {
    const graph = store.loadGraph(repoId);

    if (graph.nodes.length === 0) {
      throw new Error(
        [
          `No persisted graph found for repo "${repoId}".`,
          "Run:",
          "pnpm exec tsx src/adapters/cli/index-graph.command.ts .",
        ].join("\n"),
      );
    }

    switch (command) {
      case "callers":
        printResults(findCallers(graph, value));
        break;

      case "callees":
        printResults(findCallees(graph, value));
        break;

      case "imports":
        printResults(findImports(graph, value));
        break;

      case "imported-by":
        printResults(findImportedBy(graph, value));
        break;

      default:
        throw new Error(`Unknown graph command: ${command}`);
    }
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(error);

  process.exit(1);
});
