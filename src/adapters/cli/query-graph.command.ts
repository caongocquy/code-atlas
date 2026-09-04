import path from "node:path";

import { getRepositoryIdentity } from "../../core/repository/repository-identity.js";
import { findCallees, findCallers, findImportedBy, findImports } from "../../core/graph/query/graph-query.service.js";
import { GraphQueryEntityResolver } from "../../core/graph/query/graph-query-entity-resolver.js";
import { analyzeImpact } from "../../core/graph/query/impact.service.js";
import { traceGraph } from "../../core/graph/query/trace.service.js";
import type { GraphEntityMatch } from "../../core/graph/query/graph-query.types.js";
import type { GraphNode } from "../../core/graph/types.js";
import { AtlasStore } from "../../storage/atlas/atlas.store.js";

function describeNode(node: GraphNode): string {
  if (node.type === "file") return node.file;
  return `${node.file}:${node.startLine ?? "?"} ${node.type}:${node.name}`;
}

function printCandidate(candidate: GraphEntityMatch): void {
  const node = candidate.entity;
  console.log(`  ${node.name} :: ${node.qualifiedName ?? node.name} (${node.file}:${node.startLine ?? "?"}, ${node.type})`);
}

function printResolution(resolution: ReturnType<GraphQueryEntityResolver["resolve"]>): boolean {
  if (resolution.status === "resolved") return true;
  if (resolution.status === "not_found") {
    console.error(`No graph entity found for "${resolution.query}"`);
    return false;
  }
  console.error(`Ambiguous graph entity "${resolution.query}". Candidates:`);
  resolution.candidates.forEach(printCandidate);
  return false;
}

function printRelations(relations: ReturnType<typeof findCallers>): void {
  if (relations.length === 0) {
    console.log("(no matches)");
    return;
  }
  for (const relation of relations) console.log(`  → ${describeNode(relation.entity)}`);
}

function printImpact(result: ReturnType<typeof analyzeImpact>): void {
  if (result.status !== "resolved") {
    printResolution(result.resolution);
    return;
  }
  console.log(`Impact for ${describeNode(result.target)}`);
  console.log(`Risk: ${result.risk}`);
  console.log(`Direct: ${result.summary.directCount}`);
  console.log(`Transitive: ${result.summary.transitiveCount}`);
  if (result.mayBeIncomplete) console.log("Coverage: may be incomplete");
  if (result.truncated) console.log(`Results truncated at ${result.limits.maxResults}`);
  for (const item of [...result.directImpact, ...result.transitiveImpact]) {
    console.log(`  ${item.depth}. ${item.reason} → ${describeNode(item.entity)}`);
  }
}

function printTrace(result: ReturnType<typeof traceGraph>): void {
  if (result.status === "ambiguous" || result.status === "not_found") {
    if (result.sourceResolution.status !== "resolved") printResolution(result.sourceResolution);
    if (result.targetResolution.status !== "resolved") printResolution(result.targetResolution);
    return;
  }
  if (result.status === "no_path") {
    console.log(`No path found from ${describeNode(result.source)} to ${describeNode(result.target)}`);
    console.log(`Mode: ${result.limits.mode}; max depth: ${result.limits.maxDepth}`);
    return;
  }
  if (result.status !== "found") return;
  console.log(`Trace (${result.limits.mode}):`);
  for (const hop of result.path.hops) {
    const direction = hop.direction === "forward" ? "→" : "←";
    console.log(`  ${describeNode(hop.from)} --${hop.relation} ${direction} ${describeNode(hop.to)}`);
  }
  if (result.mayBeIncomplete) console.log("Coverage: may be incomplete");
}

function usage(): never {
  throw new Error([
    "Usage:",
    "pnpm exec tsx src/adapters/cli/query-graph.command.ts symbol <query>",
    "pnpm exec tsx src/adapters/cli/query-graph.command.ts callers <symbol>",
    "pnpm exec tsx src/adapters/cli/query-graph.command.ts callees <symbol>",
    "pnpm exec tsx src/adapters/cli/query-graph.command.ts imports <file-or-symbol>",
    "pnpm exec tsx src/adapters/cli/query-graph.command.ts imported-by <file-or-symbol>",
    "pnpm exec tsx src/adapters/cli/query-graph.command.ts impact <symbol-or-file>",
    "pnpm exec tsx src/adapters/cli/query-graph.command.ts trace <from> <to> [--explanatory]",
  ].join("\n"));
}

async function main(): Promise<void> {
  const [command, value, target] = process.argv.slice(2);
  if (!command || !value || (command === "trace" && !target)) usage();

  const repoPath = path.resolve(".");
  const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
  const repoId = store.ensureRepository(getRepositoryIdentity(repoPath)).id;

  try {
    const graph = store.loadGraph(repoId);
    if (graph.nodes.length === 0) throw new Error(`No persisted graph found for repo "${repoId}".`);

    const resolver = new GraphQueryEntityResolver(graph);
    if (command === "symbol") {
      const resolution = resolver.resolve(value);
      if (resolution.status !== "resolved") {
        printResolution(resolution);
        return;
      }
      console.log(describeNode(resolution.entity));
      console.log(`Qualified: ${resolution.entity.qualifiedName ?? resolution.entity.name}`);
      return;
    }
    if (command === "impact") {
      printImpact(analyzeImpact(graph, value, { coverage: store.getGraphResolutionCoverage(repoId) }));
      return;
    }
    if (command === "trace") {
      printTrace(traceGraph(graph, value, target!, {
        mode: process.argv.includes("--explanatory") ? "explanatory" : "directed",
        coverage: store.getGraphResolutionCoverage(repoId),
      }));
      return;
    }

    const resolution = resolver.resolve(value);
    if (resolution.status !== "resolved") {
      printResolution(resolution);
      return;
    }
    const relations = command === "callers"
      ? findCallers(graph, resolution.entity)
      : command === "callees"
        ? findCallees(graph, resolution.entity)
        : command === "imports"
          ? findImports(graph, resolution.entity)
          : command === "imported-by"
            ? findImportedBy(graph, resolution.entity)
            : undefined;
    if (!relations) throw new Error(`Unknown graph command: ${command}`);
    console.log(describeNode(resolution.entity));
    printRelations(relations);
  } finally {
    store.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
