import assert from "node:assert/strict";
import test from "node:test";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { connect, createWorkload } from "../eval/mcp/benchmark.js";
import { createDeepWorkload, createReactWorkload } from "../eval/mcp/qualification-fixtures.js";
import { readResponseGeneration } from "../src/adapters/mcp/response-options.js";
import { syncRepository } from "../src/core/indexing/index-pipeline.service.js";

test("CA-01 nonempty SQLite impact preserves paths and paginates all ten reachable nodes", async () => {
  const repoPath = await createDeepWorkload(); const { client, server } = await connect();
  try {
    const args = { repoPath, query: "deep0", maxDepth: 10, limit: 80 };
    const legacy = (await client.callTool({ name: "impact", arguments: args })).structuredContent as Record<string, any>;
    assert.equal(legacy.directImpact.length + legacy.transitiveImpact.length, 10);
    const expected = [...legacy.directImpact, ...legacy.transitiveImpact];
    const collected: typeof expected = [];
    let cursor: string | undefined;
    do {
      const result = await client.callTool({ name: "impact", arguments: { ...args, response: { mode: "full", pageSize: 2, maxOutputBytes: 32_000, ...(cursor ? { cursor } : {}) } } });
      assert.equal(result.isError, undefined);
      const value = result.structuredContent as Record<string, any>;
      collected.push(...value.directImpact, ...value.transitiveImpact); cursor = value.output.nextCursor;
      assert.equal(value.mayBeIncomplete, legacy.mayBeIncomplete);
    } while (cursor);
    assert.deepEqual(collected, expected);
    assert.equal(new Set(collected.map(item => item.entity.id)).size, 10);
    for (const item of collected) { assert.equal(item.path.length, item.depth + 1); assert.equal(item.path.at(-1), item.entity.id); }
    const bounded = (await client.callTool({ name: "impact", arguments: { ...args, maxDepth: 3, response: { mode: "focused" } } })).structuredContent as Record<string, any>;
    assert.equal(bounded.directImpact.length + bounded.transitiveImpact.length, 3);
  } finally { await client.close(); await server.close(); await rm(repoPath, { recursive: true, force: true }); }
});

test("CA-01 React/Vite application sources index and retain focused ranking", async () => {
  const repoPath = await createReactWorkload(process.cwd()); const { client, server } = await connect();
  try {
    const args = { repoPath, query: "useState", limit: 80 };
    const legacy = (await client.callTool({ name: "search_code", arguments: args })).structuredContent as Record<string, any>;
    const focused = (await client.callTool({ name: "search_code", arguments: { ...args, response: { mode: "focused", maxOutputBytes: 1_000_000 } } })).structuredContent as Record<string, any>;
    assert.ok(legacy.results.length > 0);
    assert.deepEqual(focused.results.map((item: any) => item.documentId), legacy.results.map((item: any) => item.documentId));
    assert.equal(focused.output.hasMore, false);
  } finally { await client.close(); await server.close(); await rm(repoPath, { recursive: true, force: true }); }
});

test("CA-01 concurrent clients isolate cursors, cancellation and published generations", async () => {
  const repoPath = await createWorkload(process.cwd()); const a = await connect(), b = await connect();
  try {
    const args = { repoPath, query: "largeEvidence", limit: 80, response: { mode: "compact", pageSize: 2 } };
    const [first, second] = await Promise.all([a.client.callTool({ name: "search_code", arguments: args }), b.client.callTool({ name: "search_code", arguments: args })]);
    const av = first.structuredContent as Record<string, any>, bv = second.structuredContent as Record<string, any>;
    assert.deepEqual(av.results, bv.results);
    const foreign = await b.client.callTool({ name: "search_code", arguments: { ...args, response: { ...args.response, cursor: av.output.nextCursor } } });
    assert.equal(foreign.isError, true);
    const abort = new AbortController();
    const pending = a.client.callTool({ name: "search_code", arguments: args }, undefined, { signal: abort.signal });
    abort.abort(); await assert.rejects(pending, /abort|cancel/i);
    assert.equal((await b.client.callTool({ name: "search_code", arguments: args })).isError, undefined);
    const before = readResponseGeneration(repoPath);
    await writeFile(path.join(repoPath, "new-generation.ts"), "export const newGeneration = true;\n");
    assert.equal((await syncRepository(repoPath, { skipGit: true })).kind, "published");
    assert.notEqual(readResponseGeneration(repoPath), before, "fresh reads must observe a newer committed generation");
    const stale = await a.client.callTool({ name: "search_code", arguments: { ...args, response: { ...args.response, cursor: av.output.nextCursor } } });
    assert.equal((stale.structuredContent as Record<string, any>).error.code, "stale_cursor");
  } finally { await a.client.close(); await a.server.close(); await b.client.close(); await b.server.close(); await rm(repoPath, { recursive: true, force: true }); }
});
