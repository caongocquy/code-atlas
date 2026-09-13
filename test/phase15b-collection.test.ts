import assert from "node:assert/strict";
import test from "node:test";

import { collectTaskContextCandidates, isAuthoritativeTaskResolution } from "../src/core/context/task-context-candidates.js";
import type { GraphEntityResolution } from "../src/core/graph/query/graph-query.types.js";
import type { GraphNode } from "../src/core/graph/types.js";

const entity: GraphNode = { id: "fn:main", type: "function", name: "main", qualifiedName: "App.main", file: "src/app.ts" };
const resolution = (reason: "exact_symbol_name" | "exact_qualified_name" | "exact_normalized_token" | "file_path_context" | "prefix" | "lexical_relevance", query = "main", target = entity): GraphEntityResolution => ({
  status: "resolved", query, entity: target, candidates: [{ entity: target, reason, score: 100, rank: 1 }],
});

test("authorizes exact task symbol and qualified-symbol resolutions", () => {
  assert.equal(isAuthoritativeTaskResolution("main", resolution("exact_symbol_name")), true);
  assert.equal(isAuthoritativeTaskResolution("App.main", resolution("exact_qualified_name", "App.main")), true);
  assert.equal(isAuthoritativeTaskResolution("MAIN", resolution("exact_normalized_token", "MAIN")), true);
});

test("does not promote unique prefix or lexical resolutions", () => {
  assert.equal(isAuthoritativeTaskResolution("mai", resolution("prefix", "mai")), false);
  assert.equal(isAuthoritativeTaskResolution("ain", resolution("lexical_relevance", "ain")), false);
});

test("requires exact path and symbol equality for file-qualified task targets", () => {
  assert.equal(isAuthoritativeTaskResolution("src/app.ts:main", resolution("file_path_context", "src/app.ts:main")), true);
  assert.equal(isAuthoritativeTaskResolution("src\\app.ts:main", resolution("file_path_context", "src\\app.ts:main")), true);
  assert.equal(isAuthoritativeTaskResolution("src/app.ts:mai", resolution("file_path_context", "src/app.ts:mai")), false);
  assert.equal(isAuthoritativeTaskResolution("src/other.ts:main", resolution("file_path_context", "src/other.ts:main")), false);
});

test("never authorizes unresolved or ambiguous results", () => {
  assert.equal(isAuthoritativeTaskResolution("main", { status: "ambiguous", query: "main", candidates: [] }), false);
  assert.equal(isAuthoritativeTaskResolution("main", { status: "not_found", query: "main", candidates: [] }), false);
});

test("collector promotes only an authoritative exact task target", async () => {
  const result = await collectTaskContextCandidates(
    { task: "main", anchors: [], changedPaths: [] },
    { repositoryPath: "/repo", loadGraph: async () => ({ graph: { nodes: [entity], edges: [] } }) },
  );

  assert.equal(result.candidates.length, 1);
  assert.deepEqual(result.candidates[0]!.evidence, [{ kind: "task_exact_resolution", query: "main", resolution: "symbol" }]);
  assert.equal(result.candidates[0]!.exact, true);
});

test("collector keeps a uniquely resolved prefix non-authoritative", async () => {
  const result = await collectTaskContextCandidates(
    { task: "mai", anchors: [], changedPaths: [] },
    { repositoryPath: "/repo", loadGraph: async () => ({ graph: { nodes: [entity], edges: [] } }) },
  );

  assert.equal(result.candidates.some((candidate) => candidate.evidence.some((item) => item.kind === "task_exact_resolution")), false);
  assert.equal(result.candidates.some((candidate) => candidate.subject), false);
});

test("collector keeps retrieval content out of candidates and degrades semantic failure", async () => {
  const result = await collectTaskContextCandidates(
    { task: "search", anchors: [], changedPaths: [] },
    {
      repositoryPath: "/repo",
      loadGraph: async () => ({ graph: { nodes: [entity], edges: [] } }),
      lexicalSearch: async () => [{ file: "src/app.ts", symbolName: "main", content: "secret source body", snippet: "secret" }],
      hybridSearch: async () => ({ vectorResults: [], lexicalResults: [], semanticState: "error" }),
    },
  );

  assert.equal(result.reliability.mayBeIncomplete, true);
  assert.equal(JSON.stringify(result.candidates).includes("secret"), false);
  assert.equal(result.candidates.some((candidate) => candidate.evidence.some((item) => item.kind === "task_exact_resolution")), false);
});
