import path from "node:path";

import { getRepositoryIdentity } from "../../core/repository/repository-identity.js";
import { findCallees, findCallers, findImportedBy, findImports } from "../../core/graph/query/graph-query.service.js";
import { GraphQueryEntityResolver } from "../../core/graph/query/graph-query-entity-resolver.js";
import { analyzeImpact } from "../../core/graph/query/impact.service.js";
import { traceGraph } from "../../core/graph/query/trace.service.js";
import { detectArchitecturalBridges } from "../../core/graph/intelligence/bridges.service.js";
import { detectCommunities, getCommunityById } from "../../core/graph/intelligence/communities.service.js";
import { detectStructuralCycles } from "../../core/graph/intelligence/cycles.service.js";
import { calculateImportance } from "../../core/graph/intelligence/importance.service.js";
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

function printImportant(result: ReturnType<typeof calculateImportance>): void {
  console.log(`Important symbols (${result.totalCandidates} candidates):`);
  for (const item of result.items) {
    const suppression = item.signals.suppressionReasons.length > 0
      ? `; suppression=${item.signals.suppressionReasons.join(",")}`
      : "";
    console.log(`  ${item.rank}. ${item.score.toFixed(4)} ${describeNode(item.symbol)}${suppression}`);
    console.log(`     signals callers=${item.signals.callers} callees=${item.signals.callees} importedBy=${item.signals.importedBy} dependents=${item.signals.dependents} crossFileReach=${item.signals.crossFileReach} inheritance=${item.signals.inheritance}`);
  }
  if (result.truncated) console.log(`Results truncated at ${result.items.length}`);
  if (result.mayBeIncomplete) console.log("Coverage: may be incomplete");
}

function printCommunity(community: ReturnType<typeof detectCommunities>["communities"][number]): void {
  console.log(`${community.id}: ${community.label}`);
  console.log(`  size=${community.size} quality=${community.quality} cohesion=${community.cohesion.toFixed(3)} coupling=${community.coupling.toFixed(3)}`);
  console.log(`  files=${community.files.length} internalEdges=${community.internalEdgeCount} externalEdges=${community.externalEdgeCount}`);
  if (community.representatives.length > 0) console.log(`  representatives=${community.representatives.map((node) => node.qualifiedName ?? node.name).join(", ")}`);
}

function printCommunities(result: ReturnType<typeof detectCommunities>, limit: number): void {
  const visible = result.communities.filter((community) => community.quality !== "singleton").slice(0, limit);
  console.log(`Communities: ${result.totalCommunities} (largest=${result.largestCommunitySize}, cross-community edges=${result.crossCommunityEdgeCount})`);
  visible.forEach(printCommunity);
  const hiddenSingletons = result.totalCommunities - result.communities.filter((community) => community.quality !== "singleton").length;
  if (hiddenSingletons > 0) console.log(`  ${hiddenSingletons} singleton communities omitted`);
  if (result.truncated || visible.length < result.communities.filter((community) => community.quality !== "singleton").length) console.log(`Results limited to ${limit}`);
  if (result.mayBeIncomplete) console.log("Coverage: may be incomplete");
}

function printBridges(result: ReturnType<typeof detectArchitecturalBridges>): void {
  console.log(`Architectural bridges (${result.totalCandidates} candidates):`);
  for (const bridge of result.bridges) {
    console.log(`  ${bridge.score.toFixed(4)} ${describeNode(bridge.source)} --${bridge.edge.type}→ ${describeNode(bridge.target)} (${bridge.sourceCommunityId} → ${bridge.targetCommunityId}; ${bridge.reason})`);
  }
  if (result.truncated) console.log(`Results truncated at ${result.bridges.length}`);
  if (result.mayBeIncomplete) console.log("Coverage: may be incomplete");
}

function printCycles(result: ReturnType<typeof detectStructuralCycles>): void {
  const counts = Object.entries(result.counts).map(([relation, count]) => `${relation}=${count}`).join(", ");
  console.log(`Cycles (${counts || "none"}):`);
  for (const cycle of result.cycles) {
    console.log(`  ${cycle.relation} (${cycle.length}): ${cycle.nodes.map((node) => node.qualifiedName ?? node.name).join(" → ")}`);
  }
  if (result.truncated) console.log(`Results truncated at ${result.cycles.length}`);
  if (result.mayBeIncomplete) console.log("Coverage: may be incomplete");
}

function numericOption(args: string[], name: string, fallback: number): number {
  const index = args.indexOf(name);
  const value = index >= 0 ? Number(args[index + 1]) : fallback;
  return Number.isFinite(value) ? Math.max(1, Math.floor(value)) : fallback;
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
    "pnpm exec tsx src/adapters/cli/query-graph.command.ts important [--limit N]",
    "pnpm exec tsx src/adapters/cli/query-graph.command.ts communities [--limit N]",
    "pnpm exec tsx src/adapters/cli/query-graph.command.ts community <id>",
    "pnpm exec tsx src/adapters/cli/query-graph.command.ts bridges [--limit N]",
    "pnpm exec tsx src/adapters/cli/query-graph.command.ts cycles [--limit N]",
  ].join("\n"));
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const [command, value, target] = args;
  const architectureCommand = ["important", "communities", "community", "bridges", "cycles"].includes(command ?? "");
  if (!command || (!architectureCommand && !value) || (command === "trace" && !target) || (command === "community" && !value)) usage();

  const repoPath = path.resolve(".");
  const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
  const repoId = store.ensureRepository(getRepositoryIdentity(repoPath)).id;

  try {
    const graph = store.loadGraph(repoId);
    if (graph.nodes.length === 0) throw new Error(`No persisted graph found for repo "${repoId}".`);

    const resolver = new GraphQueryEntityResolver(graph);
    const coverage = store.getGraphResolutionCoverage(repoId);
    if (command === "important") {
      printImportant(calculateImportance(graph, { limit: numericOption(args, "--limit", 10), coverage }));
      return;
    }
    if (command === "communities" || command === "community" || command === "bridges") {
      const communities = detectCommunities(graph, { maxResults: 10_000, includeSingletons: true, coverage });
      if (command === "communities") {
        printCommunities(communities, numericOption(args, "--limit", 20));
        return;
      }
      if (command === "community") {
        const community = getCommunityById(communities, value!);
        if (!community) throw new Error(`Community not found: ${value}`);
        printCommunity(community);
        return;
      }
      printBridges(detectArchitecturalBridges(graph, communities, { limit: numericOption(args, "--limit", 10), coverage }));
      return;
    }
    if (command === "cycles") {
      printCycles(detectStructuralCycles(graph, { maxResults: numericOption(args, "--limit", 50), coverage }));
      return;
    }
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
      printImpact(analyzeImpact(graph, value, { coverage }));
      return;
    }
    if (command === "trace") {
      printTrace(traceGraph(graph, value, target!, {
        mode: process.argv.includes("--explanatory") ? "explanatory" : "directed",
        coverage,
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
