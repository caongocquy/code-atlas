import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import test from "node:test";
import { applyContextBudgetDetailed } from "../src/core/retrieval/context-budget.js";
import { buildContext } from "../src/core/retrieval/context.js";
import type { SearchResult } from "../src/core/retrieval/code-search.service.js";
import { inspectRetrieval } from "../src/core/retrieval/retrieval-inspector.service.js";
import { connect, createWorkload } from "../eval/mcp/benchmark.js";

test("CA-01 legacy inspector budget is isolated from the corrected default", async () => {
  const chunks: SearchResult[] = ["first", "second"].map(name => ({
    score: 1, file: name + ".ts", symbolName: name, symbolType: "function", startLine: 1, endLine: 1, content: "return 1;",
  }));
  const words = (value: string) => value.trim() ? value.trim().split(/\s+/).length : 0;
  const limit = words(buildContext(chunks));
  const current = await applyContextBudgetDetailed(chunks, limit);
  const legacy = await applyContextBudgetDetailed(chunks, limit, undefined, "legacy-inspection");
  assert.deepEqual(current.chunks, chunks);
  assert.equal(current.usedTokens, limit);
  assert.deepEqual(legacy.chunks, chunks.slice(0, 1));
  assert.equal(legacy.usedTokens, words(buildContext(chunks.slice(0, 1))));
  assert.equal(legacy.decisions[1]?.included, false);
  assert.equal(legacy.decisions[1]?.tokens, limit);
  assert.equal(legacy.decisions[1]?.reason, "token-budget");
  assert.deepEqual(await applyContextBudgetDetailed(chunks, limit, undefined, "whole-context"), current);
});

test("CA-01 versionless MCP inspection retains legacy selection while explicit response uses the corrected budget", async () => {
  const repoPath = await createWorkload(process.cwd());
  const { client, server } = await connect();
  try {
    const args = { repoPath, query: "largeEvidence", graphEnabled: false };
    const corrected = await inspectRetrieval(args.query, { repoPath, graphEnabled: false, topK: 20 });
    const legacyCore = await inspectRetrieval(args.query, { repoPath, graphEnabled: false, topK: 20, contextBudgetPolicy: "legacy-inspection" });
    assert.ok(corrected.finalContext.tokens > legacyCore.finalContext.tokens);
    const call = async (response?: { mode: "full"; maxOutputBytes: number; pageSize: number }) => {
      const result = await client.callTool({ name: "inspect_retrieval", arguments: { ...args, ...(response ? { response } : {}) } });
      assert.equal(result.isError, undefined, JSON.stringify(result));
      return JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as { finalContext: { tokens: number; budget: number }; retrievalOnly: { tokens: number }; withGraph: { tokens: number }; output?: { mode: string } };
    };
    const legacy = await call();
    const explicit = await call({ mode: "full", maxOutputBytes: 1_000_000, pageSize: 100 });
    assert.equal(legacy.output, undefined);
    assert.equal(explicit.output?.mode, "full");
    for (const stage of ["retrievalOnly", "withGraph", "finalContext"] as const) {
      assert.equal(legacy[stage].tokens, legacyCore[stage].tokens);
      assert.equal(explicit[stage].tokens, corrected[stage].tokens);
    }
    assert.ok(explicit.finalContext.tokens <= explicit.finalContext.budget);
  } finally {
    await client.close(); await server.close(); await rm(repoPath, { recursive: true, force: true });
  }
});
