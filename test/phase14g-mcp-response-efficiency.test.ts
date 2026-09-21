import assert from "node:assert/strict";
import test from "node:test";

import {
  projectAffectedTestsResponse,
  projectInspectChangeResponse,
  projectRetrievalInspectionResponse,
} from "../src/adapters/mcp/mcp-server.js";

const diagnostics = {
  mayBeIncomplete: true,
  authoritativeNegativeResults: false,
  gaps: [{ kind: "stale_index", count: 2, files: ["z.ts", "a.ts"], details: ["z", "a"] }],
  metrics: [{ name: "resolution", resolved: 1, total: 2, ratio: 0.5 }],
  verificationTargets: [{ file: "z.ts", reason: "verify" }, { file: "a.ts", reason: "verify" }],
  reasons: ["incomplete"],
};

test("compact inspect_change is deterministic, bounded, and preserves reliability", () => {
  const result = {
    source: { mode: "working" },
    summary: { changedFiles: 3, changedSymbols: 3, affectedSymbols: 3, affectedFiles: 3 },
    files: ["z.ts", "a.ts", "m.ts"].map((file) => ({ path: file, status: "modified", hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 }] })),
    changedSymbols: ["z", "a", "m"].map((name, index) => ({ symbolId: name, name, kind: "function", file: `${name}.ts`, changeKind: "modified", startLine: index + 1 })),
    affectedSymbols: ["z", "a", "m"].map((name, index) => ({ symbolId: name, name, kind: "function", file: `${name}.ts`, originatingSymbols: [name], relation: "calls", depth: 1, path: [name], reason: "affected", startLine: index + 1 })),
    affectedFiles: ["z.ts", "a.ts", "m.ts"],
    risk: "unknown",
    mayBeIncomplete: true,
    reasons: ["incomplete"],
    diagnostics,
  };
  const compact = projectInspectChangeResponse(result, "compact", 2);
  assert.deepEqual(compact.files.map((item) => item.path), ["a.ts", "m.ts"]);
  assert.deepEqual(compact.changedSymbols.map((item) => item.name), ["a", "m"]);
  assert.equal(compact.mayBeIncomplete, true);
  assert.equal(compact.diagnostics.authoritativeNegativeResults, false);
  assert.deepEqual(compact.omitted, { affectedFiles: 1, affectedSymbols: 1, changedSymbols: 1, files: 1 });
  assert.equal(compact.truncated, true);
  assert.equal(compact.detailsAvailable, true);
  assert.deepEqual(projectInspectChangeResponse(result, "full"), result);
});

test("compact affected_tests bounds nested evidence and reports omissions", () => {
  const result = {
    source: { mode: "working" },
    change: { changedFiles: 1, changedSymbols: 1, affectedSymbols: 1 },
    summary: { testsToRun: 3, changedTests: 2, affectedProductionSymbols: 1, symbolsWithTestEvidence: 1, uncoveredAffectedSymbols: 2 },
    tests: ["z.test.ts", "a.test.ts", "m.test.ts"].map((file) => ({ file, testSymbols: [], reasons: [{ kind: "direct_reference", affectedSymbolId: file }], confidence: "high" })),
    changedTests: ["z.test.ts", "a.test.ts"],
    uncoveredAffectedSymbols: ["z", "a", "m"].map((name) => ({ symbolId: name, name, kind: "function", file: `${name}.ts`, reason: "no_structural_test_evidence" })),
    uncoveredAffectedFiles: ["z.ts", "a.ts", "m.ts"],
    mayBeIncomplete: true,
    reasons: ["incomplete"],
    diagnostics,
  };
  const compact = projectAffectedTestsResponse(result, "compact", 2);
  assert.deepEqual(compact.tests.map((item) => item.file), ["a.test.ts", "m.test.ts"]);
  assert.deepEqual(compact.omitted, { tests: 1, uncoveredAffectedFiles: 1, uncoveredAffectedSymbols: 1 });
  assert.equal(compact.diagnostics.verificationTargets.length, 2);
  assert.deepEqual(projectAffectedTestsResponse(result, "full"), result);
});

test("compact retrieval inspection deduplicates stage chunks and uses bounded output", () => {
  const chunk = (key: string, file: string) => ({ key, source: "lexical", file, content: `${key} content`, score: 1 });
  const inspection = {
    query: "AuthService",
    repoId: "repo",
    options: {},
    vectorResults: [chunk("same", "a.ts"), chunk("vector", "v.ts")],
    lexicalResults: [chunk("same", "a.ts"), chunk("lexical", "l.ts")],
    fusedResults: [chunk("same", "a.ts"), chunk("fused", "f.ts")],
    rerankedResults: [],
    graphExpansion: { details: [] },
    retrievalOnly: { chunks: [chunk("same", "a.ts")], dropped: [], tokens: 1, budget: 10, rendered: "same" },
    withGraph: { chunks: [chunk("same", "a.ts")], dropped: [], tokens: 1, budget: 10, rendered: "same" },
    finalContext: { chunks: [chunk("same", "a.ts")], dropped: [], tokens: 1, budget: 10, rendered: "same" },
    metrics: {},
    capabilities: {},
  };
  const compact = projectRetrievalInspectionResponse(inspection as never, "compact", 2);
  assert.equal(compact.vectorResults.length, 2);
  assert.equal(compact.lexicalResults.some((item) => item.key === "same"), false);
  assert.equal(compact.truncated, true);
  assert.equal((compact.omitted as { duplicateChunks: number }).duplicateChunks >= 1, true);
  assert.deepEqual(JSON.stringify(projectRetrievalInspectionResponse(inspection as never, "full")), JSON.stringify(inspection));
});
