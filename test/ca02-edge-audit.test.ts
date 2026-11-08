import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import type { CodeGraph, GraphEdge, GraphNode } from "../src/core/graph/types.js";

type GoldExpectation = {
  file: string;
  line: number;
  caller: string;
  callee: string | null;
  kind: "expected" | "unresolved";
  notes?: string;
};
type Forbidden = { caller: string; callee: string; notes?: string };
type Gold = {
  expectations: GoldExpectation[];
  forbidden: Forbidden[];
};

const fixtureRoot = fileURLToPath(new URL("./fixtures/ca02-edge-audit/", import.meta.url));
const manifestPath = path.join(fixtureRoot, "gold.json");

function isCallEdge(edge: GraphEdge): boolean {
  return edge.type === "calls";
}

function nodeLabel(node: GraphNode): string {
  return node.qualifiedName ?? node.name;
}

function matchesName(node: GraphNode | undefined, target: string): boolean {
  if (!node) return false;
  const name = nodeLabel(node);
  return name === target || name.endsWith(`.${target}`);
}

function hasMatchingCall(graph: CodeGraph, caller: string, callee: string, file?: string, line?: number): boolean {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.edges.some((edge) => {
    if (!isCallEdge(edge)) return false;
    const source = nodes.get(edge.from);
    const target = nodes.get(edge.to);
    if (!matchesName(source, caller) || !matchesName(target, callee)) return false;
    if (file === undefined || line === undefined) return true;
    return edge.resolution?.evidence.some((item) => item.sourceUnit === file && item.startLine === line) ?? false;
  });
}

test("CA-02 gold fixture callsites reference existing source lines", async () => {
  const gold = JSON.parse(await readFile(manifestPath, "utf8")) as Gold;
  assert.ok(gold.expectations.length > 0);
  assert.ok(gold.forbidden.length > 0);
  const checked = new Set<string>();
  for (const entry of gold.expectations) {
    assert.equal(Number.isSafeInteger(entry.line) && entry.line > 0, true);
    const source = (await readFile(path.join(fixtureRoot, entry.file), "utf8")).split(/\r?\n/);
    const line = source[entry.line - 1];
    assert.ok(line && line.includes("("), `missing callsite: ${entry.file}:${entry.line}`);
    const identity = `${entry.file}:${entry.line}`;
    assert.equal(checked.has(identity), false, `duplicate gold callsite: ${identity}`);
    checked.add(identity);
  }
});

test("CA-02 characterize published gold calls, uncertainty and resolution provenance", async () => {
  const gold = JSON.parse(await readFile(manifestPath, "utf8")) as Gold;
  const root = await mkdtemp(path.join(os.tmpdir(), "ca02-edge-baseline-"));
  try {
    for (const file of ["source.ts", "reexport.ts", "consumer.ts"]) {
      await mkdir(path.dirname(path.join(root, file)), { recursive: true });
      await writeFile(path.join(root, file), await readFile(path.join(fixtureRoot, file)));
    }
    const indexed = await indexRepository(root, { skipGit: true });
    assert.equal(indexed.kind, "published", JSON.stringify(indexed));
    const repositoryId = getRepositoryIdentity(root).id;
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      const graph = store.loadGraph(repositoryId);
      const coverage = store.getGraphResolutionCoverage(repositoryId);
      const diagnostics = store.getGraphResolutionDiagnostics(repositoryId);
      const nodeIds = new Set(graph.nodes.map((node) => node.id));
      const callEdges = graph.edges.filter(isCallEdge);
      for (const edge of callEdges) {
        assert.ok(nodeIds.has(edge.from), "call edge from missing graph node");
        assert.ok(nodeIds.has(edge.to), "call edge to missing graph node");
        if (edge.resolution) {
          assert.ok(["exact", "strong"].includes(edge.resolution.confidence));
          assert.ok(edge.resolution.strategy);
          assert.ok(edge.resolution.resolutionVersion);
        }
      }
      const positives = gold.expectations.filter((entry) => entry.kind === "expected" && entry.callee !== null);
      const truePositives = positives.filter((entry) =>
        hasMatchingCall(graph, entry.caller, entry.callee!, entry.file, entry.line));
      const falseNegatives = positives.filter((entry) =>
        !hasMatchingCall(graph, entry.caller, entry.callee!, entry.file, entry.line));
      const falsePositives = gold.forbidden.filter((entry) =>
        hasMatchingCall(graph, entry.caller, entry.callee));
      const expectedUnresolved = gold.expectations.filter((entry) => entry.kind === "unresolved");
      const callEdgeSummaries = callEdges.map((edge) => {
        const source = graph.nodes.find((node) => node.id === edge.from);
        const target = graph.nodes.find((node) => node.id === edge.to);
        return {
          caller: source ? nodeLabel(source) : null,
          callee: target ? nodeLabel(target) : null,
          provenance: edge.resolution ? {
            strategy: edge.resolution.strategy,
            confidence: edge.resolution.confidence,
            sites: edge.resolution.evidence.map((item) => `${item.sourceUnit}:${item.startLine}`),
          } : null,
        };
      });
      // Characterization only: report actual baseline before defining a regression gate.
      // No fabricated precision/recall claims or assumptions about parser capabilities.
      const report = {
        corpus: "ca02-edge-audit",
        expectedPositives: positives.length,
        truePositives: truePositives.length,
        falseNegatives: falseNegatives.map((item) => `${item.file}:${item.line} ${item.caller}->${item.callee}`),
        forbiddenMatched: falsePositives,
        precisionOnLabeledPredictions: truePositives.length + falsePositives.length > 0
          ? truePositives.length / (truePositives.length + falsePositives.length) : null,
        recallOnLabeledPositives: positives.length > 0 ? truePositives.length / positives.length : null,
        expectedUnresolved: expectedUnresolved.length,
        coverage,
        diagnosticsCount: diagnostics.length,
        diagnosticReasons: diagnostics.map((item) => ({
          kind: item.kind,
          line: item.source.line,
          file: item.source.file,
          reason: item.kind === "ambiguous" ? item.ambiguityReason : item.reason,
        })),
        callEdges: callEdgeSummaries,
        caveat: "Oracle-limited, source/line-aware measurement; not repository-wide recall.",
      };
      console.log("CA02_GOLD_BASELINE " + JSON.stringify(report));
      assert.ok(Array.isArray(diagnostics));
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
