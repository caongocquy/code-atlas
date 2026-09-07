import { analyzeImpact } from "../graph/query/impact.service.js";
import type { CodeGraph, GraphNode } from "../graph/types.js";
import { readGraphDeltaContext } from "./graph-delta.service.js";
import type { GraphDeltaContext } from "./graph-delta.service.js";
import {
  createCoverageDiagnostics,
} from "../diagnostics/coverage-diagnostics.service.js";
import { mergeResolutionCoverage } from "../graph/resolution.types.js";
import type {
  AffectedSymbol,
  ChangedSymbol,
  InspectChangeInput,
  InspectChangeResult,
} from "./change.types.js";

const DEFAULT_MAX_DEPTH = 3;
const MAX_IMPACT_RESULTS = 1_000;

function nodeKey(node: Pick<GraphNode, "file" | "type" | "qualifiedName" | "name">): string {
  return `${node.file}\0${node.type}\0${node.qualifiedName ?? node.name}`;
}

function overlaps(node: GraphNode, start: number, lines: number): boolean {
  if (lines === 0) return false;
  const end = node.endLine ?? node.startLine ?? 0;
  const nodeStart = node.startLine ?? end;
  const changedEnd = lines === 0 ? start : start + lines - 1;
  return nodeStart <= changedEnd && end >= start;
}

function clampDepth(value: number | undefined): number {
  return Math.max(0, Math.min(10, Math.floor(value ?? DEFAULT_MAX_DEPTH)));
}

function addReason(reasons: Set<string>, reason: string): void {
  reasons.add(reason);
}

function impactQuery(node: GraphNode): string {
  return node.file.includes("/") && node.qualifiedName
    ? `${node.file}:${node.qualifiedName}`
    : node.qualifiedName ?? node.name;
}

export type InspectChangeAnalysis = {
  result: InspectChangeResult;
  context: GraphDeltaContext;
};

export async function analyzeInspectChange(
  repoPath: string,
  input: InspectChangeInput = {},
): Promise<InspectChangeAnalysis> {
  const context = await readGraphDeltaContext(repoPath, input);
  return analyzeInspectChangeFromContext(input, context);
}

export function analyzeInspectChangeFromContext(
  input: InspectChangeInput,
  context: GraphDeltaContext,
): InspectChangeAnalysis {
  const { changes } = context;
  const reasons = new Set<string>();
  const targetNodes = context.after.graph.nodes.filter((node) => node.type !== "file");
  const baselineNodes = context.before.graph.nodes.filter((node) => node.type !== "file");
  const changedSymbols: ChangedSymbol[] = [];
  const impactSeeds: Array<{ node: GraphNode; graph: CodeGraph }> = [];
  let unmappedHunks = 0;
  const unmappedFiles = new Set<string>();
  let missingBaseline = 0;

  for (const file of changes.files) {
    if (file.status === "binary") {
      addReason(reasons, `binary file has no symbol mapping: ${file.path}`);
      continue;
    }

    const current = targetNodes.filter((node) => node.file === file.path);
    const old = file.status === "added"
      ? []
      : baselineNodes.filter((node) => node.file === (file.oldPath ?? file.path));
    const oldByKey = new Map(old.map((node) => [nodeKey(node), node]));
    const matchedNew = new Set<string>();
    const matchedOld = new Set<string>();

    for (const hunk of file.hunks) {
      const newMatches = current.filter((node) => overlaps(node, hunk.newStart, hunk.newLines));
      const oldMatches = old.filter((node) => overlaps(node, hunk.oldStart, hunk.oldLines));
      if (newMatches.length === 0 && oldMatches.length === 0) {
        unmappedHunks += 1;
        unmappedFiles.add(file.path);
        continue;
      }
      for (const node of newMatches) {
        matchedNew.add(nodeKey(node));
        const kind = oldByKey.has(nodeKey(node)) ? "modified" : "added";
        changedSymbols.push({
          symbolId: node.id,
          name: node.name,
          kind: node.type,
          file: node.file,
          startLine: node.startLine,
          endLine: node.endLine,
          changeKind: kind,
        });
        if (kind === "modified") impactSeeds.push({ node, graph: context.after.graph });
      }
      for (const node of oldMatches) matchedOld.add(nodeKey(node));
    }

    for (const node of old) {
      if (!matchedOld.has(nodeKey(node)) || matchedNew.has(nodeKey(node))) continue;
      changedSymbols.push({
        symbolId: node.id,
        name: node.name,
        kind: node.type,
        file: node.file,
        startLine: node.startLine,
        endLine: node.endLine,
        changeKind: "deleted",
      });
      impactSeeds.push({ node, graph: context.before.graph });
    }

    if (file.hunks.length > 0 && current.length === 0 && old.length === 0 && file.status === "deleted") {
      missingBaseline += file.hunks.length;
    }
  }

  if (unmappedHunks > 0) {
    addReason(reasons, `${unmappedHunks} changed hunk${unmappedHunks === 1 ? "" : "s"} could not be mapped to symbols`);
  }

  const uniqueChanged = [...new Map(changedSymbols.map((symbol) => [`${symbol.symbolId}:${symbol.changeKind}`, symbol])).values()]
    .sort((a, b) => a.file.localeCompare(b.file) || (a.startLine ?? 0) - (b.startLine ?? 0) || a.name.localeCompare(b.name));
  const changedIds = new Set(uniqueChanged.map((symbol) => symbol.symbolId));
  const affected = new Map<string, AffectedSymbol>();
  let risk: InspectChangeResult["risk"] = uniqueChanged.length === 0 && changes.files.length > 0 ? "unknown" : "low";
  const depth = clampDepth(input.maxDepth);

  for (const seed of impactSeeds) {
      const result = analyzeImpact(seed.graph, impactQuery(seed.node), {
        maxDepth: depth,
        maxResults: MAX_IMPACT_RESULTS,
        coverage: { mayBeIncomplete: false },
      });
      if (result.mayBeIncomplete) addReason(reasons, "impact evidence is incomplete");
      if (result.truncated) addReason(reasons, "impact results were truncated by the analysis bound");
      if (result.status !== "resolved") {
        addReason(reasons, `changed symbol could not be resolved in the source graph: ${seed.node.name}`);
        continue;
      }
      if (result.risk === "high" || (result.risk === "medium" && risk === "low")) risk = result.risk;
      if (result.risk === "unknown") risk = "unknown";
      for (const item of [...result.directImpact, ...result.transitiveImpact]) {
        if (changedIds.has(item.entity.id)) continue;
        const existing = affected.get(item.entity.id);
        if (existing) {
          existing.originatingSymbols = [...new Set([...existing.originatingSymbols, seed.node.id])].sort();
          continue;
        }
        affected.set(item.entity.id, {
          symbolId: item.entity.id,
          name: item.entity.name,
          kind: item.entity.type,
          file: item.entity.file,
          startLine: item.entity.startLine,
          endLine: item.entity.endLine,
          originatingSymbols: [seed.node.id],
          relation: item.relation,
          depth: item.depth,
          path: item.path,
          reason: item.reason,
        });
      }
  }

  const affectedSymbols = [...affected.values()].sort((a, b) => a.depth - b.depth || a.file.localeCompare(b.file) || a.name.localeCompare(b.name));
  const changeDiagnostics = createCoverageDiagnostics({
    resolutionCoverage: mergeResolutionCoverage(context.before.coverage, context.after.coverage),
    resolutionDiagnostics: [...context.before.diagnostics, ...context.after.diagnostics],
    change: {
      files: changes.files,
      mayBeIncomplete: reasons.size > 0,
      reasons: [...reasons],
      unmappedHunks,
      unmappedFiles: [...unmappedFiles],
      missingBaseline,
    },
  });
  const diagnostics = changeDiagnostics;
  const mayBeIncomplete = reasons.size > 0 || diagnostics.mayBeIncomplete;
  if (mayBeIncomplete) risk = "unknown";
  const affectedFiles = [...new Set(affectedSymbols.map((symbol) => symbol.file))].sort();

  const result: InspectChangeResult = {
    source: changes.source,
    summary: {
      changedFiles: changes.files.length,
      changedSymbols: uniqueChanged.length,
      affectedSymbols: affectedSymbols.length,
      affectedFiles: affectedFiles.length,
    },
    files: changes.files,
    changedSymbols: uniqueChanged,
    affectedSymbols,
    affectedFiles,
    risk,
    mayBeIncomplete,
    reasons: [...new Set([...reasons, ...diagnostics.reasons])],
    diagnostics,
  };
  return { result, context };
}

export async function inspectChange(
  repoPath: string,
  input: InspectChangeInput = {},
): Promise<InspectChangeResult> {
  return (await analyzeInspectChange(repoPath, input)).result;
}
