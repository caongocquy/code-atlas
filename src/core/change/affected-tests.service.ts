import fs from "node:fs/promises";
import path from "node:path";

import { analyzeImpact } from "../graph/query/impact.service.js";
import { loadIndexedGraphReadOnly } from "../graph/indexed-graph.service.js";
import type { GraphNode } from "../graph/types.js";
import type { CodeGraph } from "../graph/types.js";
import { analyzeInspectChange, inspectChange, type InspectChangeAnalysis } from "./inspect-change.service.js";
import { createCoverageDiagnostics, mergeCoverageDiagnostics } from "../diagnostics/coverage-diagnostics.service.js";
import type {
  AffectedTest,
  AffectedTestsInput,
  AffectedTestsResult,
  SymbolReference,
  TestEvidence,
} from "./test-intelligence.types.js";
import type { ChangedSymbol } from "./change.types.js";

const DEFAULT_MAX_TESTS = 100;
const MAX_TRAVERSAL_RESULTS = 1_000;

export function isTestFile(file: string): boolean {
  const normalized = file.replaceAll("\\", "/");
  const parts = normalized.split("/");
  const basename = parts.at(-1) ?? "";
  return parts.some((part) => part === "test" || part === "tests" || part === "__tests__")
    || /(?:^|[._-])(test|spec)(?:[._-]|$)/i.test(basename);
}

function symbolReference(node: GraphNode): SymbolReference {
  return {
    symbolId: node.id,
    name: node.name,
    kind: node.type,
    file: node.file,
    startLine: node.startLine,
    endLine: node.endLine,
  };
}

function changedReference(symbol: ChangedSymbol): SymbolReference {
  return {
    symbolId: symbol.symbolId,
    name: symbol.name,
    kind: symbol.kind,
    file: symbol.file,
    startLine: symbol.startLine,
    endLine: symbol.endLine,
  };
}

function queryFor(node: GraphNode): string {
  return node.file.includes("/") && node.qualifiedName
    ? `${node.file}:${node.qualifiedName}`
    : node.qualifiedName ?? node.name;
}

function maxTestsFor(input: AffectedTestsInput): number {
  return Math.max(1, Math.min(1_000, Math.floor(input.maxTests ?? DEFAULT_MAX_TESTS)));
}

function confidenceFor(kind: TestEvidence["kind"], distance: number): AffectedTest["confidence"] {
  if (kind === "direct_reference") return "high";
  if (kind === "import_dependency") return "high";
  return distance <= 2 ? "medium" : "low";
}

function evidenceKey(evidence: TestEvidence): string {
  if (evidence.kind === "call_path") return `${evidence.kind}:${evidence.affectedSymbolId}:${evidence.path.join("/")}`;
  if (evidence.kind === "direct_reference") return `${evidence.kind}:${evidence.affectedSymbolId}`;
  return `${evidence.kind}:${evidence.affectedFile}`;
}

function productionTargets(
  change: Awaited<ReturnType<typeof inspectChange>>,
): Array<{ reference: SymbolReference }> {
  const targets = new Map<string, { reference: SymbolReference }>();
  for (const symbol of change.changedSymbols) {
    if (!isTestFile(symbol.file) && symbol.kind !== "file") targets.set(symbol.symbolId, { reference: changedReference(symbol) });
  }
  for (const symbol of change.affectedSymbols) {
    if (!isTestFile(symbol.file) && symbol.kind !== "file") {
      targets.set(symbol.symbolId, { reference: {
        symbolId: symbol.symbolId,
        name: symbol.name,
        kind: symbol.kind,
        file: symbol.file,
        startLine: symbol.startLine,
        endLine: symbol.endLine,
      } });
    }
  }
  return [...targets.values()].sort((a, b) => a.reference.file.localeCompare(b.reference.file) || a.reference.name.localeCompare(b.reference.name));
}

function changedTestFiles(change: Awaited<ReturnType<typeof inspectChange>>): string[] {
  return [...new Set(change.files.filter((file) => isTestFile(file.path)).map((file) => file.path))].sort();
}

function addEvidence(
  tests: Map<string, AffectedTest>,
  evidence: TestEvidence,
  node: GraphNode,
  distance: number,
): void {
  const file = node.file;
  const existing = tests.get(file) ?? {
    file,
    testSymbols: [],
    reasons: [],
    distance,
    confidence: confidenceFor(evidence.kind, distance),
  };
  if (!existing.reasons.some((item) => evidenceKey(item) === evidenceKey(evidence))) existing.reasons.push(evidence);
  if (node.type !== "file" && !existing.testSymbols?.some((item) => item.symbolId === node.id)) {
    existing.testSymbols = [...(existing.testSymbols ?? []), symbolReference(node)];
  }
  existing.distance = Math.min(existing.distance ?? distance, distance);
  const confidenceRank = { low: 0, medium: 1, high: 2 };
  if (confidenceRank[confidenceFor(evidence.kind, distance)] > confidenceRank[existing.confidence]) {
    existing.confidence = confidenceFor(evidence.kind, distance);
  }
  existing.reasons.sort((left, right) => evidenceKey(left).localeCompare(evidenceKey(right)));
  existing.testSymbols?.sort((left, right) => left.file.localeCompare(right.file) || left.name.localeCompare(right.name));
  tests.set(file, existing);
}

export async function affectedTestsFromChange(
  repoPath: string,
  input: AffectedTestsInput = {},
  change: Awaited<ReturnType<typeof inspectChange>>,
  analysis?: InspectChangeAnalysis,
): Promise<AffectedTestsResult> {
  const reasons = new Set(change.reasons);
  const tests = new Map<string, AffectedTest>();
  const targets = productionTargets(change);
  let graph: Awaited<ReturnType<typeof loadIndexedGraphReadOnly>> | undefined;
  let targetGraph: CodeGraph | undefined = analysis?.context.after.graph;
  let baselineGraph: CodeGraph | undefined = analysis?.context.before.graph;

  if (!analysis) {
    try {
      await fs.access(path.join(repoPath, ".codeatlas", "atlas.db"));
      graph = await loadIndexedGraphReadOnly(repoPath);
    } catch {
      reasons.add("indexed graph is unavailable for structural test evidence");
    }
    targetGraph = graph?.graph;
  }

  const uncoveredAffectedSymbols = [] as AffectedTestsResult["uncoveredAffectedSymbols"];
  const coveredSymbols = new Set<string>();
  for (const target of targets) {
    const node = targetGraph?.nodes.find((candidate) => candidate.id === target.reference.symbolId)
      ?? baselineGraph?.nodes.find((candidate) => candidate.id === target.reference.symbolId);
    const analysisGraph = node && targetGraph?.nodes.some((candidate) => candidate.id === node.id)
      ? targetGraph
      : baselineGraph ?? targetGraph;
    const incomplete = analysis?.context.after.coverage.mayBeIncomplete
      || analysis?.context.before.coverage.mayBeIncomplete
      || graph?.mayBeIncomplete;
    if (!analysisGraph || !node || node.type === "file") {
      reasons.add(`no indexed structural test evidence for ${target.reference.name}`);
      uncoveredAffectedSymbols.push({ ...target.reference, reason: "no_structural_test_evidence" });
      continue;
    }

    let foundForTarget = false;
    const impacts = [analyzeImpact(analysisGraph, queryFor(node), {
      maxDepth: input.maxDepth,
      maxResults: MAX_TRAVERSAL_RESULTS,
      coverage: { mayBeIncomplete: incomplete ?? false },
    })];
    const fileNode = analysisGraph.nodes.find((candidate) => candidate.type === "file" && candidate.file === node.file);
    if (fileNode) impacts.push(analyzeImpact(analysisGraph, queryFor(fileNode), {
      maxDepth: input.maxDepth,
      maxResults: MAX_TRAVERSAL_RESULTS,
      coverage: { mayBeIncomplete: incomplete ?? false },
    }));

    for (const impact of impacts) {
      if (impact.mayBeIncomplete) reasons.add("test relationship evidence is incomplete");
      if (impact.truncated) reasons.add("test relationship traversal was truncated by the analysis bound");
      if (impact.status !== "resolved") {
        reasons.add(`changed symbol could not be resolved for test discovery: ${target.reference.name}`);
        continue;
      }
      for (const item of [...impact.directImpact, ...impact.transitiveImpact]) {
        if (!isTestFile(item.entity.file)) continue;
        const evidence: TestEvidence = item.entity.type === "file" && item.relation === "imports"
          ? { kind: "import_dependency", affectedFile: target.reference.file }
          : item.depth === 1 && item.relation === "calls"
            ? { kind: "direct_reference", affectedSymbolId: target.reference.symbolId }
            : { kind: "call_path", affectedSymbolId: target.reference.symbolId, path: item.path };
        addEvidence(tests, evidence, item.entity, item.depth);
        coveredSymbols.add(target.reference.symbolId);
        foundForTarget = true;
      }
    }
    if (!foundForTarget) {
      reasons.add(`no indexed structural test evidence for ${target.reference.name}`);
      uncoveredAffectedSymbols.push({ ...target.reference, reason: "no_structural_test_evidence" });
    }
  }

  const allUncoveredFiles = change.files
    .filter((file) => !isTestFile(file.path) && file.hunks.length > 0 && !change.changedSymbols.some((symbol) => symbol.file === file.path))
    .map((file) => file.path)
    .sort();
  if (allUncoveredFiles.length > 0) reasons.add(`${allUncoveredFiles.length} changed file${allUncoveredFiles.length === 1 ? "" : "s"} had no symbol mapping`);

  const maxTests = maxTestsFor(input);
  const orderedTests = [...tests.values()].sort((left, right) => {
    const confidenceRank = { low: 0, medium: 1, high: 2 };
    return confidenceRank[right.confidence] - confidenceRank[left.confidence]
      || (left.distance ?? Number.MAX_SAFE_INTEGER) - (right.distance ?? Number.MAX_SAFE_INTEGER)
      || left.file.localeCompare(right.file);
  });
  const testsTruncated = orderedTests.length > maxTests;
  if (testsTruncated) reasons.add(`test results were truncated at ${maxTests}`);
  const selectedTests = orderedTests.slice(0, maxTests);

  const uncovered = [...new Map(uncoveredAffectedSymbols.map((symbol) => [symbol.symbolId, symbol])).values()]
    .sort((left, right) => left.file.localeCompare(right.file) || left.name.localeCompare(right.name));
  const diagnostics = mergeCoverageDiagnostics(change.diagnostics, createCoverageDiagnostics({
    tests: {
      mayBeIncomplete: testsTruncated || reasons.has("indexed graph is unavailable for structural test evidence")
        || [...reasons].some((reason) => reason.includes("incomplete") || reason.includes("truncated")),
      indexUnavailable: reasons.has("indexed graph is unavailable for structural test evidence"),
      reasons: [...reasons],
      uncoveredAffectedSymbols: uncovered,
      uncoveredAffectedFiles: allUncoveredFiles,
    },
  }));
  const mayBeIncomplete = change.mayBeIncomplete || diagnostics.mayBeIncomplete;
  return {
    source: change.source,
    change: {
      changedFiles: change.summary.changedFiles,
      changedSymbols: change.summary.changedSymbols,
      affectedSymbols: change.summary.affectedSymbols,
    },
    summary: {
      testsToRun: selectedTests.length,
      changedTests: changedTestFiles(change).length,
      affectedProductionSymbols: targets.length,
      symbolsWithTestEvidence: coveredSymbols.size,
      uncoveredAffectedSymbols: uncovered.length,
    },
    tests: selectedTests,
    changedTests: changedTestFiles(change),
    uncoveredAffectedSymbols: uncovered,
    uncoveredAffectedFiles: allUncoveredFiles,
    mayBeIncomplete,
    reasons: [...new Set([...reasons, ...diagnostics.reasons])],
    diagnostics,
  };
}

export async function affectedTests(
  repoPath: string,
  input: AffectedTestsInput = {},
): Promise<AffectedTestsResult> {
  const analysis = await analyzeInspectChange(repoPath, input);
  return affectedTestsFromChange(repoPath, input, analysis.result, analysis);
}
