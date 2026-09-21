import assert from "node:assert/strict";
import test from "node:test";

import { enrichTaskContextCandidates, enrichTaskContextGraph } from "../src/core/context/task-context-candidates.js";
import type { NormalizedTaskContextInput } from "../src/core/context/task-context.types.js";
import type { TaskContextCandidate } from "../src/core/context/task-context.types.js";
import type { CodeGraph } from "../src/core/graph/types.js";
import { resolveLanguageImportCandidates } from "../src/core/graph/imports.js";

test("graph enrichment is one-hop and capped per required seed", () => {
  const seed: TaskContextCandidate = { subject: { kind: "symbol", path: "src/a.ts", symbolId: "a", selectorVersion: "1" }, evidence: [{ kind: "explicit_anchor", anchor: { kind: "symbol", path: "src/a.ts", name: "a" } }], sourceRanks: {}, exact: true };
  const graph: CodeGraph = { nodes: [
    { id: "a", type: "function", name: "a", file: "src/a.ts" },
    ...Array.from({ length: 6 }, (_, index) => ({ id: `b${index}`, type: "function" as const, name: `b${index}`, file: `src/b${index}.ts` })),
    { id: "c", type: "function", name: "c", file: "src/c.ts" },
  ], edges: [
    ...Array.from({ length: 6 }, (_, index) => ({ from: "a", to: `b${index}`, type: "calls" as const })),
    { from: "b0", to: "c", type: "calls" as const },
  ] };
  const result = enrichTaskContextGraph([seed], graph);
  assert.equal(result.filter((candidate) => candidate.subject?.symbolId?.startsWith("b")).length, 5);
  assert.equal(result.some((candidate) => candidate.subject?.symbolId === "c"), false);
  assert.equal(result.find((candidate) => candidate.subject?.symbolId === "b0")?.exact, true);
});

test("graph enrichment follows imports from an anchored file", () => {
  const seed: TaskContextCandidate = { subject: { kind: "file", path: "main.ts" }, evidence: [{ kind: "explicit_anchor", anchor: { kind: "file", path: "main.ts" } }], sourceRanks: {}, exact: true };
  const graph: CodeGraph = {
    nodes: [
      { id: "main", type: "file", name: "main.ts", file: "main.ts" },
      { id: "related", type: "file", name: "related.ts", file: "related.ts" },
    ],
    edges: [{ from: "main", to: "related", type: "imports" }],
  };
  const result = enrichTaskContextGraph([seed], graph);
  assert.equal(result.some((candidate) => candidate.subject?.kind === "file" && candidate.subject.path === "related.ts"), true);
});

test("language import resolution maps Python, Kotlin, and Rust module imports to local files", () => {
  assert.deepEqual(resolveLanguageImportCandidates("main.py", ".related", "python"), ["related.py", "related/__init__.py"]);
  assert.deepEqual(resolveLanguageImportCandidates("main.kt", "fixture.Related.helper", "kotlin"), ["related.kt"]);
  assert.deepEqual(resolveLanguageImportCandidates("main.rs", "crate::related::helper", "rust"), ["related.rs", "related/mod.rs"]);
});

test("change, impact, and affected-test enrichment is relevant, bounded, and incomplete-safe", async () => {
  const seed: TaskContextCandidate = { subject: { kind: "symbol", path: "src/a.ts", symbolId: "a", selectorVersion: "1" }, evidence: [{ kind: "explicit_changed_path", path: "src/a.ts" }], sourceRanks: {}, exact: true };
  const graph: CodeGraph = { nodes: [
    { id: "a", type: "function", name: "a", file: "src/a.ts" },
    { id: "b", type: "function", name: "b", file: "src/b.ts" },
    { id: "test", type: "function", name: "a test", file: "test/a.test.ts" },
    { id: "unrelated", type: "function", name: "other", file: "src/other.ts" },
  ], edges: [] };
  const normalized: NormalizedTaskContextInput = { task: "a", anchors: [], changedPaths: ["src/a.ts"] };
  const result = await enrichTaskContextCandidates([seed], normalized, graph, {
    repositoryPath: "/repo",
    loadGraph: async () => ({ graph }),
    inspectChange: async () => ({
      changedSymbols: [{ symbolId: "a", name: "a", kind: "function", file: "src/a.ts" }],
      affectedSymbols: [{ symbolId: "unrelated", name: "other", kind: "function", file: "src/other.ts", relation: "calls", depth: 1 }],
      files: [{ path: "src/a.ts" }],
      mayBeIncomplete: false,
    }),
    analyzeImpact: async () => ({ status: "resolved", directImpact: [{ entity: graph.nodes[1], relation: "calls", depth: 1 }], transitiveImpact: [], mayBeIncomplete: true, truncated: false }),
    affectedTests: async () => ({ tests: [{ file: "test/a.test.ts", confidence: "high", testSymbols: [{ symbolId: "a", name: "a", kind: "function", file: "test/a.test.ts" }] }, { file: "test/other.test.ts", confidence: "high", testSymbols: [{ symbolId: "unrelated", name: "other", kind: "function", file: "test/other.test.ts" }] }], mayBeIncomplete: false }),
  });
  assert.equal(result.reliability.mayBeIncomplete, true);
  assert.deepEqual(result.reliability.diagnostics, ["impact enrichment is incomplete"]);
  assert.equal(result.candidates.some((candidate) => candidate.subject?.path === "src/b.ts"), true);
  assert.equal(result.candidates.some((candidate) => candidate.subject?.path === "test/a.test.ts"), true);
  assert.equal(result.candidates.some((candidate) => candidate.subject?.path === "src/other.ts"), false);
  assert.ok(result.candidates.filter((candidate) => candidate.evidence.some((evidence) => evidence.kind === "impact")).length <= 10);
});
