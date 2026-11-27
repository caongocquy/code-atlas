import assert from "node:assert/strict";
import test from "node:test";

import { applyContextBudget, applyContextBudgetDetailed } from "../src/core/retrieval/context-budget.js";
import { buildContext } from "../src/core/retrieval/context.js";
import type { SearchResult } from "../src/core/retrieval/code-search.service.js";

function chunk(name: string, content: string): SearchResult {
  return { score: 1, file: `${name}.ts`, symbolName: name, symbolType: "function", startLine: 1, endLine: 1, content };
}

function words(text: string): number {
  return text.trim() ? text.trim().split(/\s+/).length : 0;
}

test("CA-01 retrieval budget admits the complete rendered context at the exact token limit", async () => {
  const chunks = [chunk("first", "return 1;"), chunk("second", "return 2;")];
  const limit = words(buildContext(chunks));
  const detailed = await applyContextBudgetDetailed(chunks, limit);
  assert.deepEqual(detailed.chunks, chunks);
  assert.equal(detailed.usedTokens, limit);
  assert.equal(detailed.budget, limit);
  assert.deepEqual(detailed.decisions.map(({ tokens, included }) => ({ tokens, included })), [
    { tokens: words(buildContext(chunks.slice(0, 1))), included: true },
    { tokens: limit, included: true },
  ]);
  assert.deepEqual(await applyContextBudget(chunks, limit), { chunks, usedTokens: limit });
  const below = await applyContextBudgetDetailed(chunks, limit - 1);
  assert.deepEqual(below.chunks, chunks.slice(0, 1));
  assert.equal(below.decisions[1]?.reason, "token-budget");
});

test("CA-01 retrieval budget skips oversized candidates without charging rejected context", async () => {
  const first = chunk("first", "return 1;");
  const oversized = chunk("oversized", "word ".repeat(300));
  const last = chunk("last", "return 2;");
  const limit = words(buildContext([first, last]));
  const result = await applyContextBudgetDetailed([first, oversized, last], limit);
  assert.deepEqual(result.chunks, [first, last]);
  assert.equal(result.usedTokens, limit);
  assert.deepEqual(result.decisions.map((decision) => decision.included), [true, false, true]);
  assert.equal(result.decisions[1]?.reason, "token-budget");
  assert.equal(result.decisions[1]?.tokens, words(buildContext([first, oversized])));
  assert.equal(result.decisions[2]?.tokens, limit);
});

test("CA-01 retrieval budget uses the supplied whole-context counter including non-additive overhead", async () => {
  const chunks = [chunk("first", "alpha"), chunk("second", "beta"), chunk("third", "gamma")];
  const count = (text: string) => text ? words(text) + 7 : 0;
  const calls: string[] = [];
  const counter = async (text: string) => { calls.push(text); return count(text); };
  const limit = count(buildContext(chunks));
  const result = await applyContextBudgetDetailed(chunks, limit, counter);
  assert.deepEqual(result.chunks, chunks);
  assert.equal(result.usedTokens, limit);
  assert.deepEqual(calls, chunks.map((_, index) => buildContext(chunks.slice(0, index + 1))));
});

test("CA-01 retrieval budget preserves empty and zero-budget behavior", async () => {
  assert.deepEqual(await applyContextBudgetDetailed([], 0), { chunks: [], usedTokens: 0, decisions: [], budget: 0 });
  const candidate = chunk("first", "alpha");
  const result = await applyContextBudgetDetailed([candidate], 0);
  assert.deepEqual(result.chunks, []);
  assert.equal(result.usedTokens, 0);
  assert.equal(result.decisions[0]?.reason, "token-budget");
});
