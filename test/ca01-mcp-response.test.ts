import assert from "node:assert/strict";
import test from "node:test";
import { rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { connect, createWorkload } from "../eval/mcp/benchmark.js";
import { syncRepository } from "../src/core/indexing/index-pipeline.service.js";

test("CA-01 modes preserve ranking and bound the complete MCP response", async () => {
  const repoPath = await createWorkload(process.cwd());
  const { client, server } = await connect();
  try {
    const call = async (response?: Record<string, unknown>, args = {}) => {
      const result = await client.callTool({ name: "search_code", arguments: { repoPath, query: "largeEvidence", limit: 80, ...args, ...(response ? { response } : {}) } });
      const text = (result.content as Array<{ type: string; text: string }>).find(item => item.type === "text")!.text;
      return { result, value: text.startsWith("{") ? JSON.parse(text) : { raw: text }, bytes: Buffer.byteLength(JSON.stringify(result)) };
    };
    const legacy = await call();
    assert.equal(legacy.result.isError, undefined);
    assert.equal(legacy.value.output, undefined);
    for (const mode of ["compact", "focused", "full"]) {
      const optimized = await call({ mode, maxOutputBytes: 1_000_000, pageSize: 100 });
      assert.equal(optimized.result.isError, undefined, JSON.stringify(optimized.value));
      assert.equal(optimized.value.output.mode, mode);
      assert.deepEqual(optimized.value.results.map((x: { documentId: string }) => x.documentId), legacy.value.results.map((x: { documentId: string }) => x.documentId));
      assert.equal(JSON.stringify(optimized.value), JSON.stringify(optimized.result.structuredContent));
      if (mode === "compact") assert.equal(optimized.value.results[0].content, undefined);
      if (mode === "focused") assert.ok(optimized.bytes < legacy.bytes * .6);
      if (mode === "full") assert.deepEqual(optimized.value.results, legacy.value.results);
    }
    const bounded = await call({ mode: "focused", maxOutputBytes: 8_000, pageSize: 100 });
    assert.equal(bounded.result.isError, undefined);
    assert.ok(bounded.bytes <= 8_000);
    assert.equal(bounded.value.output.hasMore, true);
    assert.equal(bounded.value.output.truncated, true);
    assert.ok(bounded.value.output.nextCursor);
    assert.ok(bounded.value.results.length > 0);
    const compact = await call({ mode: "focused", sections: [], maxOutputTokens: 2_000, pageSize: 100 });
    assert.ok(compact.bytes <= 8_000);
    assert.equal(compact.value.results[0].content, undefined);
    assert.equal(compact.value.output.tokenBudgetIsEstimate, true);
    for (const response of [{ mode: "invalid" }, { mode: "compact", sections: ["unknown"] }, { mode: "full", relationKinds: ["unsafe"] }, { mode: "compact", maxOutputBytes: -1 }, { mode: "compact", unknown: true }]) {
      assert.equal((await call(response)).result.isError, true);
    }
    const tiny = await call({ mode: "full", maxOutputBytes: 512 });
    assert.equal(tiny.result.isError, true);
    assert.equal(tiny.value.error.code, "output_budget_too_small");
    assert.ok(tiny.bytes <= 512);
    const empty = await call({ mode: "compact" }, { query: "missingZZZZZZ" });
    assert.equal(empty.value.results.length, 0);
    assert.equal(empty.value.output.hasMore, false);
  } finally {
    await client.close(); await server.close(); await rm(repoPath, { recursive: true, force: true });
  }
});

test("CA-01 cursor pages repeat and reject modified requests and generations", async () => {
  const repoPath = await createWorkload(process.cwd());
  const { client, server } = await connect();
  try {
    const options = { mode: "compact", pageSize: 7, maxOutputBytes: 32_000 };
    const call = async (response: Record<string, unknown>, query = "largeEvidence") => {
      const result = await client.callTool({ name: "search_code", arguments: { repoPath, query, limit: 80, response } });
      const text = (result.content as Array<{ text: string }>)[0].text;
      return { result, value: text.startsWith("{") ? JSON.parse(text) : { raw: text } };
    };
    const first = await call(options);
    assert.equal(first.result.isError, undefined, JSON.stringify(first.value));
    const cursor = first.value.output.nextCursor;
    assert.ok(cursor);
    const second = await call({ ...options, cursor });
    assert.deepEqual(second.value, (await call({ ...options, cursor })).value);
    const collected = [...first.value.results, ...second.value.results];
    let next = second.value.output.nextCursor;
    while (next) {
      const page = await call({ ...options, cursor: next });
      assert.equal(page.result.isError, undefined);
      collected.push(...page.value.results); next = page.value.output.nextCursor;
    }
    assert.equal(collected.length, 80);
    assert.equal(new Set(collected.map(item => item.documentId)).size, 80);
    const legacy = await client.callTool({ name: "search_code", arguments: { repoPath, query: "largeEvidence", limit: 80 } });
    assert.deepEqual(collected.map(item => item.documentId), JSON.parse((legacy.content as Array<{ text: string }>)[0].text).results.map((item: { documentId: string }) => item.documentId));
    for (const changed of [{ ...options, cursor: "invalid" }, { ...options, cursor: cursor + "x" }, { ...options, cursor, pageSize: 8 }, { ...options, cursor, sections: [] }]) {
      assert.equal((await call(changed)).result.isError, true);
    }
    assert.equal((await call({ ...options, cursor }, "differentQuery")).result.isError, true);
    const other = await connect();
    try {
      const result = await other.client.callTool({ name: "search_code", arguments: { repoPath, query: "largeEvidence", limit: 80, response: { ...options, cursor } } });
      assert.equal(result.isError, true);
    } finally { await other.client.close(); await other.server.close(); }
    await writeFile(path.join(repoPath, "new.ts"), "export const extra = true;\n");
    assert.notEqual((await syncRepository(repoPath, { skipGit: true })).kind, "failed");
    const stale = await call({ ...options, cursor });
    assert.equal(stale.result.isError, true);
    assert.equal(stale.value.error.code, "stale_cursor");
  } finally {
    await client.close(); await server.close(); await rm(repoPath, { recursive: true, force: true });
  }
});
