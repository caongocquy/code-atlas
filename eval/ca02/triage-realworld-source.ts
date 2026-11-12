import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { extractParsedFacts } from "../../src/core/facts/facts-extractor.js";
import { getRepositoryIdentity } from "../../src/core/repository/repository-identity.js";
import { AtlasStore } from "../../src/storage/atlas/atlas.store.js";

type TriageCase = {
  id: string;
  file: string;
  line: number;
  sourceNeedle: string;
  calleeName: string;
  category: "internal_candidate" | "external_builtin" | "dynamic_callback";
  targetFile?: string;
  targetName?: string;
  explanation: string;
};

/**
 * Source-reviewed candidates only, NOT independent ground truth.
 * Anchors are from p-queue@7f272ab5f; tests guard against drift.
 */
export const pQueueTriageCases: readonly TriageCase[] = [
  { id: "pqueue-imported-lowerbound", file: "source/priority-queue.ts", line: 88, sourceNeedle: "lowerBound(this.#queue", calleeName: "lowerBound", category: "internal_candidate", targetFile: "source/lower-bound.ts", targetName: "lowerBound", explanation: "Default import on source/priority-queue.ts:2 points to the function declaration on source/lower-bound.ts:3." },
  { id: "pqueue-instance-enqueue", file: "source/priority-queue.ts", line: 104, sourceNeedle: "this.enqueue(item!.run", calleeName: "this.enqueue", category: "internal_candidate", targetFile: "source/priority-queue.ts", targetName: "PriorityQueue.enqueue", explanation: "Inside PriorityQueue.setPriority, this refers to PriorityQueue; enqueue is declared at line 58." },
  { id: "pqueue-private-findindex", file: "source/priority-queue.ts", line: 93, sourceNeedle: "this.#findIndex(element", calleeName: "this.#findIndex", category: "internal_candidate", targetFile: "source/priority-queue.ts", targetName: "PriorityQueue.#findIndex", explanation: "PriorityQueue private method declared at line 29 and invoked inside setPriority." },
  { id: "pqueue-private-compact", file: "source/priority-queue.ts", line: 52, sourceNeedle: "this.#compact()", calleeName: "this.#compact", category: "internal_candidate", targetFile: "source/priority-queue.ts", targetName: "PriorityQueue.#compact", explanation: "PriorityQueue private method declared at line 18 and called by #removeFirst." },
  { id: "pqueue-private-removefirst", file: "source/priority-queue.ts", line: 114, sourceNeedle: "this.#removeFirst()", calleeName: "this.#removeFirst", category: "internal_candidate", targetFile: "source/priority-queue.ts", targetName: "PriorityQueue.#removeFirst", explanation: "PriorityQueue private method declared at line 40 and called by remove." },
  { id: "pqueue-validate-limit", file: "source/index.ts", line: 60, sourceNeedle: "validateLimit('intervalCap'", calleeName: "validateLimit", category: "internal_candidate", targetFile: "source/index.ts", targetName: "validateLimit", explanation: "File-local const arrow declaration at line 53; may be represented as a variable rather than function graph node." },
  { id: "pqueue-builtin-trunc", file: "source/lower-bound.ts", line: 8, sourceNeedle: "Math.trunc(count / 2)", calleeName: "Math.trunc", category: "external_builtin", explanation: "Math.trunc is a JavaScript built-in with no project-local function target." },
  { id: "pqueue-parameter-comparator", file: "source/lower-bound.ts", line: 11, sourceNeedle: "comparator(array[it]!", calleeName: "comparator", category: "dynamic_callback", explanation: "Function-valued comparator parameter is supplied by the caller; no unique callee declaration can be selected from this call alone." },
];

function flag(name: string): string {
  const at = process.argv.indexOf(name);
  assert.ok(at >= 0 && process.argv[at + 1], "Missing " + name);
  return process.argv[at + 1]!;
}

export async function auditPinnedRepository(root: string, commit: string) {
  assert.match(commit, /^[a-f0-9]{40}$/);
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" });
  assert.equal(sha.status, 0, sha.stderr);
  assert.equal(sha.stdout.trim(), commit, "Source tree must be pinned");
  const db = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"), { readOnly: true });
  let graph;
  try { graph = db.loadGraph(getRepositoryIdentity(root).id); }
  finally { db.close(); }
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  const edges = graph.edges.filter((edge) => edge.type === "calls");
  const files = new Map<string, { lines: string[]; calls: { calleeText: string; range: { startLine: number } }[] }>();
  const rows = [];
  for (const entry of pQueueTriageCases) {
    if (!files.has(entry.file)) {
      const source = await readFile(path.join(root, entry.file), "utf8");
      const result = extractParsedFacts({ source, filePath: entry.file, language: "typescript",
        contentHash: createHash("sha256").update(source).digest("hex") });
      assert.equal(result.kind, "facts");
      if (result.kind !== "facts") throw new Error("Parser did not return facts");
      files.set(entry.file, { lines: source.split("\n"), calls: result.facts.callSites });
    }
    const file = files.get(entry.file)!;
    assert.ok(file.lines[entry.line - 1]?.includes(entry.sourceNeedle),
      `${entry.id}: pinned source anchor mismatch`);
    const matchingCallsites = file.calls.filter((site) => site.range.startLine === entry.line &&
      (site.calleeText === entry.calleeName || site.calleeText.replace(/\s/g, "") === entry.calleeName.replace(/\s/g, "")));
    // This is instrumentation; unknown AST forms are findings, not silent drops.
    const targetNodes = entry.targetFile
      ? graph.nodes.filter((node) => node.file === entry.targetFile &&
        (node.qualifiedName === entry.targetName || node.name === entry.targetName ||
          node.qualifiedName?.endsWith(`.${entry.targetName?.split(".").at(-1)}`)))
      : [];
    const matchingEdges = edges.filter((edge) =>
      edge.resolution?.evidence.some((evidence) => evidence.sourceUnit === entry.file && evidence.startLine === entry.line)
      && (entry.targetFile ? targetNodes.some((node) => node.id === edge.to) : true));
    rows.push({
      id: entry.id, source: { file: entry.file, line: entry.line, text: file.lines[entry.line - 1]!.trim() },
      category: entry.category,
      sourceReviewedTarget: entry.targetFile ? { file: entry.targetFile, symbol: entry.targetName } : null,
      explanation: entry.explanation,
      parserCallsiteCount: matchingCallsites.length,
      targetRepresentedAsGraphNode: targetNodes.length > 0,
      targetGraphNodeTypes: [...new Set(targetNodes.map((node) => node.type))].sort(),
      matchingPublishedCallEdges: matchingEdges.length,
      review: { authorSourceChecked: true, independentReviewer: null, independentlyAdjudicated: false },
    });
  }
  return {
    sourceCommit: commit,
    coverage: {
      cases: rows.length,
      internalCandidates: rows.filter((row) => row.category === "internal_candidate").length,
      externalBuiltins: rows.filter((row) => row.category === "external_builtin").length,
      dynamicCallbacks: rows.filter((row) => row.category === "dynamic_callback").length,
      sourceCallsitesFound: rows.filter((row) => row.parserCallsiteCount > 0).length,
      internalTargetsRepresented: rows.filter((row) => row.category === "internal_candidate" && row.targetRepresentedAsGraphNode).length,
      internalCandidatesWithPublishedEdge: rows.filter((row) => row.category === "internal_candidate" && row.matchingPublishedCallEdges > 0).length,
    },
    accuracy: null,
    status: "author_source_review_only",
    rows,
  };
}

if (process.argv[1] && /triage-realworld-source\.(?:ts|js)$/.test(process.argv[1])) {
  const result = await auditPinnedRepository(path.resolve(flag("--repo")), flag("--commit"));
  const destination = path.resolve(flag("--output"));
  await mkdir(path.dirname(destination), { recursive: true });
  await writeFile(destination, JSON.stringify(result, null, 2) + "\n");
  process.stdout.write("CA02_SOURCE_TRIAGE " + JSON.stringify(result.coverage) + "\n");
}
