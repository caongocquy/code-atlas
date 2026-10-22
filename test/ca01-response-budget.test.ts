import assert from "node:assert/strict";
import test from "node:test";
import { optimizeResponse, responseBytes, McpResponseError } from "../src/adapters/mcp/response-options.js";

const key = Buffer.alloc(32, 7);
const now = 1_000_000;
const generation = "repository:generation";
const item = (id: number) => ({ documentId: `symbol-${id}`, file: "C:/repo/đường dẫn.ts", startLine: id + 1, content: "🌏".repeat(900), snippet: "duplicate", score: 1 });

test("CA-01 byte budgets preserve valid Unicode/JSON and exact boundaries", () => {
  const value = { results: [item(0), item(1)], mayBeIncomplete: false };
  const response = { mode: "focused", maxOutputBytes: 1_000_000 };
  const optimize = (budget: number) => optimizeResponse("search_code", { query: "tied", response: { ...response, maxOutputBytes: budget } }, value, generation, key, now);
  const large = optimize(1_000_000);
  const exact = responseBytes(large);
  assert.equal(responseBytes(optimize(exact)), exact);
  assert.deepEqual(large, optimize(1_000_000));
  assert.equal((large.results as Array<{ content: string }>)[0]!.content.length, 600);
  for (const budget of [512, 1_000, 1_800, 3_200, 5_000, 12_000, 64_000]) {
    try {
      const result = optimize(budget);
      assert.ok(responseBytes(result) <= budget);
      const json = JSON.stringify(result);
      assert.deepEqual(JSON.parse(Buffer.from(json).toString("utf8")), result);
      assert.doesNotMatch(json, /\\u[dD][89aAbB][0-9a-fA-F]{2}|\\u[dD][c-fC-F][0-9a-fA-F]{2}/);
    } catch (error) {
      assert.ok(error instanceof McpResponseError);
      assert.equal(error.code, "output_budget_too_small");
    }
  }
  assert.equal(value.results[0]!.content.length, 1_800, "projection must not mutate source evidence");
});

test("CA-01 relation filters preserve ordering and expose intentional omission", () => {
  const value = { results: [
    { entity: item(0), relation: "calls", edge: { type: "calls", evidence: ["proof"] } },
    { entity: item(1), relation: "imports", edge: { type: "imports" } },
    { entity: item(2), relation: "calls", edge: { type: "calls" } },
  ], mayBeIncomplete: true, reliability: { authoritativeNegativeResults: false } };
  const result = optimizeResponse("impact", { query: "target", response: { mode: "compact", relationKinds: ["calls"] } }, value, generation, key, now);
  assert.deepEqual((result.results as typeof value.results).map(row => row.entity.documentId), ["symbol-0", "symbol-2"]);
  assert.equal((result.output as { filteredRelations: number }).filteredRelations, 1);
  assert.equal((result.output as { projectionComplete: boolean }).projectionComplete, false);
  assert.equal(result.mayBeIncomplete, true);
  assert.deepEqual(result.reliability, value.reliability);
  assert.equal(value.results.length, 3);
});

test("CA-01 signed cursors expire and changed snapshots cannot continue", () => {
  const response = { mode: "compact", pageSize: 1, maxOutputBytes: 10_000 };
  const args = { query: "tied", response };
  const value = { results: [item(0), item(1)] };
  const first = optimizeResponse("search_code", args, value, generation, key, now);
  const cursor = (first.output as { nextCursor: string }).nextCursor;
  const nextArgs = { ...args, response: { ...response, cursor } };
  assert.throws(() => optimizeResponse("search_code", nextArgs, value, generation, key, now + 15 * 60_000), (error: unknown) => error instanceof McpResponseError && error.code === "expired_cursor");
  assert.throws(() => optimizeResponse("search_code", nextArgs, { results: [item(1)] }, generation, key, now), (error: unknown) => error instanceof McpResponseError && error.code === "stale_cursor");
});

test("CA-01 reports oversized scalar/nested evidence instead of corrupting it", () => {
  assert.throws(() => optimizeResponse("get_symbol", { response: { mode: "full", maxOutputBytes: 512 } }, {
    entity: { id: "large", evidence: { nested: ["deep".repeat(20_000)] } }, mayBeIncomplete: true,
  }, generation, key, now), (error: unknown) => error instanceof McpResponseError && error.code === "output_budget_too_small");
});

test("CA-01 inspection keeps one primary ranking when repeated stages are omitted", () => {
  const value = { query: "evidence", fusedResults: [item(0)], lexicalResults: [item(0)], metrics: { totalMs: 1 } };
  const compact = optimizeResponse("inspect_retrieval", { response: { mode: "compact" } }, value, generation, key, now);
  assert.equal(compact.fusedResults, undefined);
  assert.equal(compact.lexicalResults, undefined);
  assert.equal((compact.results as Array<{ documentId: string }>)[0]!.documentId, "symbol-0");
  const full = optimizeResponse("inspect_retrieval", { response: { mode: "full", maxOutputBytes: 100_000 } }, value, generation, key, now);
  assert.deepEqual(full.fusedResults, value.fusedResults);
  assert.deepEqual(full.lexicalResults, value.lexicalResults);
});

for (const relationKinds of [["calls"], ["extends"]]) {
  test(`CA-01 relation counts distinguish before/after filtering: ${relationKinds}`, () => {
    const value = { results: [{ relation: "calls", id: 1 }, { relation: "imports", id: 2 }, { relation: "calls", id: 3 }], totalReturned: 3 };
    const before = structuredClone(value);
    const response = { mode: "compact", relationKinds, pageSize: 1, maxOutputBytes: 10_000 };
    const first = optimizeResponse("find_callers", { response }, value, generation, key, now);
    const afterFilter = relationKinds[0] === "calls" ? 2 : 0;
    assert.equal(first.totalReturned, Math.min(afterFilter, 1));
    assert.deepEqual((first.output as { resultCounts: unknown }).resultCounts, { beforeFilter: 3, afterFilter });
    if (afterFilter) {
      const cursor = (first.output as { nextCursor: string }).nextCursor;
      const second = optimizeResponse("find_callers", { response: { ...response, cursor } }, value, generation, key, now);
      assert.equal(second.totalReturned, 1);
      assert.deepEqual(second.results, [value.results[2]]);
      assert.deepEqual((second.output as { resultCounts: unknown }).resultCounts, { beforeFilter: 3, afterFilter: 2 });
      assert.equal((second.output as { hasMore: boolean }).hasMore, false);
    } else assert.deepEqual(first.results, []);
    assert.deepEqual(value, before);
    assert.ok(responseBytes(first) <= response.maxOutputBytes);
  });
}
test("CA-01 relation totalReturned describes the current unfiltered page", () => {
  const value = { results: [{ relation: "calls" }, { relation: "imports" }], totalReturned: 2 };
  const result = optimizeResponse("find_callers", { response: { mode: "compact", pageSize: 1 } }, value, generation, key, now);
  assert.equal(result.totalReturned, 1);
  assert.deepEqual((result.output as { resultCounts: unknown }).resultCounts, { beforeFilter: 2, afterFilter: 2 });
});
