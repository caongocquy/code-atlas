import type { ResolutionCoverage } from "../resolution.types.js";
import type { CodeGraph, GraphNode } from "../types.js";
import type {
  ImportantSymbol,
  ImportanceOptions,
  ImportanceResult,
  ImportanceSignals,
} from "./graph-intelligence.types.js";

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 1_000;

const KIND_WEIGHT: Record<GraphNode["type"], number> = {
  class: 1.15,
  interface: 1.1,
  enum: 1.05,
  function: 1,
  type: 0.95,
  method: 0.9,
  variable: 0.65,
  file: 0.55,
};

const ARCHITECTURAL_EDGE_TYPES = new Set(["calls", "imports", "extends", "implements", "references"]);

type Counts = {
  callers: number;
  callees: number;
  importedBy: number;
  dependents: number;
  crossFileReach: number;
  inheritance: number;
  totalDegree: number;
};

function nodeKey(node: GraphNode): string {
  return [node.file, node.type, node.qualifiedName ?? node.name, node.id].join(":");
}

function clampLimit(value: number | undefined): number {
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(value ?? DEFAULT_LIMIT)));
}

function normalized(value: number, maximum: number): number {
  if (maximum <= 0 || value <= 0) return 0;
  return Math.log1p(value) / Math.log1p(maximum);
}

function isGeneratedPath(file: string): boolean {
  return /(^|\/)(node_modules|dist|build|coverage|generated|vendor|\.codeatlas)(\/|$)/i.test(file);
}

function isGenericHubName(name: string): boolean {
  return /^(default|index|constructor|module|exports?|common|util|utils|helper|helpers)$/i.test(name);
}

function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor((sorted.length - 1) * fraction)] ?? 0;
}

function createCounts(graph: CodeGraph): Map<string, Counts> {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const incomingCalls = new Map<string, number>();
  const outgoingCalls = new Map<string, number>();
  const incomingDependents = new Map<string, Set<string>>();
  const inheritance = new Map<string, number>();
  const crossFileReach = new Map<string, Set<string>>();
  const importedByFile = new Map<string, Set<string>>();
  const degree = new Map<string, number>();

  const addCrossFileReach = (nodeId: string, file: string): void => {
    const set = crossFileReach.get(nodeId) ?? new Set<string>();
    set.add(file);
    crossFileReach.set(nodeId, set);
  };

  for (const edge of graph.edges) {
    if (!ARCHITECTURAL_EDGE_TYPES.has(edge.type)) continue;

    degree.set(edge.from, (degree.get(edge.from) ?? 0) + 1);
    degree.set(edge.to, (degree.get(edge.to) ?? 0) + 1);

    const source = nodeById.get(edge.from);
    const target = nodeById.get(edge.to);
    if (!source || !target) continue;

    if (source.file !== target.file) {
      addCrossFileReach(source.id, target.file);
      addCrossFileReach(target.id, source.file);
    }

    if (edge.type === "calls" || edge.type === "references") {
      incomingCalls.set(edge.to, (incomingCalls.get(edge.to) ?? 0) + 1);
      outgoingCalls.set(edge.from, (outgoingCalls.get(edge.from) ?? 0) + 1);
      const dependents = incomingDependents.get(edge.to) ?? new Set<string>();
      dependents.add(edge.from);
      incomingDependents.set(edge.to, dependents);
    }

    if (edge.type === "extends" || edge.type === "implements") {
      inheritance.set(edge.to, (inheritance.get(edge.to) ?? 0) + 1);
      inheritance.set(edge.from, (inheritance.get(edge.from) ?? 0) + 1);
      const dependents = incomingDependents.get(edge.to) ?? new Set<string>();
      dependents.add(edge.from);
      incomingDependents.set(edge.to, dependents);
    }

    if (edge.type === "imports") {
      const importers = importedByFile.get(target.file) ?? new Set<string>();
      importers.add(source.file);
      importedByFile.set(target.file, importers);
    }
  }

  for (const node of graph.nodes) {
    const importers = importedByFile.get(node.file) ?? new Set<string>();
    for (const importer of importers) {
      if (importer !== node.file) addCrossFileReach(node.id, importer);
    }
  }

  return new Map(graph.nodes.map((node) => [node.id, {
    callers: incomingCalls.get(node.id) ?? 0,
    callees: outgoingCalls.get(node.id) ?? 0,
    importedBy: importedByFile.get(node.file)?.size ?? 0,
    dependents: incomingDependents.get(node.id)?.size ?? 0,
    crossFileReach: crossFileReach.get(node.id)?.size ?? 0,
    inheritance: inheritance.get(node.id) ?? 0,
    totalDegree: degree.get(node.id) ?? 0,
  }]));
}

function signalSet(counts: Counts, maximums: Counts): ImportanceSignals["normalized"] {
  return {
    callers: normalized(counts.callers, maximums.callers),
    callees: normalized(counts.callees, maximums.callees),
    importedBy: normalized(counts.importedBy, maximums.importedBy),
    dependents: normalized(counts.dependents, maximums.dependents),
    crossFileReach: normalized(counts.crossFileReach, maximums.crossFileReach),
    inheritance: normalized(counts.inheritance, maximums.inheritance),
  };
}

function suppressionFor(
  node: GraphNode,
  counts: Counts,
  hubThreshold: number,
): { penalty: number; reasons: string[] } {
  const reasons: string[] = [];
  if (isGeneratedPath(node.file)) reasons.push("generated-or-vendored-path");
  if (node.type === "file") reasons.push("file-hub");

  const localHub = counts.totalDegree >= Math.max(8, hubThreshold)
    && counts.crossFileReach <= Math.max(1, Math.floor(counts.totalDegree * 0.25));
  if (localHub) reasons.push("high-local-degree-hub");

  if (isGenericHubName(node.name) && counts.totalDegree >= 6) {
    reasons.push("generic-high-degree-name");
  }

  if (reasons.includes("generated-or-vendored-path")) return { penalty: 0.3, reasons };
  if (reasons.includes("file-hub")) return { penalty: 0.35, reasons };
  if (reasons.length > 0) return { penalty: 0.55, reasons };
  return { penalty: 1, reasons };
}

function scoreSignals(normalizedSignals: ImportanceSignals["normalized"]): number {
  // Log-normalized signals keep one unusually large count from dominating the score.
  // Weights: callers .30, callees .10, imported-by .20, dependents .20,
  // cross-file reach .15, inheritance .05; kind and noise weights apply later.
  return normalizedSignals.callers * 0.3
    + normalizedSignals.callees * 0.1
    + normalizedSignals.importedBy * 0.2
    + normalizedSignals.dependents * 0.2
    + normalizedSignals.crossFileReach * 0.15
    + normalizedSignals.inheritance * 0.05;
}

export function calculateImportance(
  graph: CodeGraph,
  options: ImportanceOptions = {},
): ImportanceResult {
  const limit = clampLimit(options.limit);
  const candidates = graph.nodes
    .filter((node) => options.includeFiles === true || node.type !== "file")
    .sort((left, right) => nodeKey(left).localeCompare(nodeKey(right)));
  const counts = createCounts(graph);
  const maximums = candidates.reduce<Counts>((max, node) => {
    const value = counts.get(node.id)!;
    return {
      callers: Math.max(max.callers, value.callers),
      callees: Math.max(max.callees, value.callees),
      importedBy: Math.max(max.importedBy, value.importedBy),
      dependents: Math.max(max.dependents, value.dependents),
      crossFileReach: Math.max(max.crossFileReach, value.crossFileReach),
      inheritance: Math.max(max.inheritance, value.inheritance),
      totalDegree: Math.max(max.totalDegree, value.totalDegree),
    };
  }, { callers: 0, callees: 0, importedBy: 0, dependents: 0, crossFileReach: 0, inheritance: 0, totalDegree: 0 });
  const hubThreshold = percentile(candidates.map((node) => counts.get(node.id)!.totalDegree), 0.95);

  const items = candidates.map<ImportantSymbol>((symbol) => {
    const raw = counts.get(symbol.id)!;
    const normalizedSignals = signalSet(raw, maximums);
    const suppression = suppressionFor(symbol, raw, hubThreshold);
    const signals: ImportanceSignals = {
      ...raw,
      normalized: normalizedSignals,
      kindWeight: KIND_WEIGHT[symbol.type],
      noisePenalty: suppression.penalty,
      suppressionReasons: suppression.reasons,
    };
    return {
      symbol,
      score: scoreSignals(normalizedSignals) * signals.kindWeight * suppression.penalty / 1.15,
      rank: 0,
      signals,
    };
  }).sort((left, right) => right.score - left.score || nodeKey(left.symbol).localeCompare(nodeKey(right.symbol)));

  const ranked = items.map((item, index) => ({ ...item, rank: index + 1 })).slice(0, limit);
  return {
    items: ranked,
    totalCandidates: candidates.length,
    truncated: candidates.length > limit,
    normalization: "log1p-max",
    mayBeIncomplete: options.coverage?.mayBeIncomplete ?? false,
  };
}
