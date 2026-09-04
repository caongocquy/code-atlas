import type { CodeGraph } from "../types.js";
import { detectArchitecturalBridges } from "./bridges.service.js";
import { detectCommunities } from "./communities.service.js";
import { detectStructuralCycles } from "./cycles.service.js";
import { calculateImportance } from "./importance.service.js";
import type {
  GraphIntelligenceOptions,
  GraphIntelligenceResult,
} from "./graph-intelligence.types.js";

export function analyzeGraphIntelligence(
  graph: CodeGraph,
  options: GraphIntelligenceOptions = {},
): GraphIntelligenceResult {
  const communities = detectCommunities(graph, {
    ...options.communities,
    maxResults: Math.max(10_000, options.communities?.maxResults ?? 0),
    includeSingletons: true,
    coverage: options.coverage,
  });
  const importance = calculateImportance(graph, { ...options.importance, coverage: options.coverage });
  const bridges = detectArchitecturalBridges(graph, communities, { ...options.bridges, coverage: options.coverage });
  const cycles = detectStructuralCycles(graph, { ...options.cycles, coverage: options.coverage });
  return {
    importance,
    communities,
    bridges,
    cycles,
    mayBeIncomplete: options.coverage?.mayBeIncomplete ?? false,
  };
}
