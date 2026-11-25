import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { expandGraphContextDetailed } from "../src/core/graph/expand.js";
import type { CodeGraph } from "../src/core/graph/types.js";
import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { searchableIdentifier } from "../src/core/lexical/searchable-identifier.js";
import { inspectRetrieval } from "../src/core/retrieval/retrieval-inspector.service.js";

test("CA-01 graph expansion resolves an encoded lexical seed only at its source occurrence", () => {
  const graph: CodeGraph = {
    nodes: [
      { id: "first", type: "method", name: "loadCache", file: "cache.ts", startLine: 3 },
      { id: "second", type: "method", name: "loadCache", file: "cache.ts", startLine: 8 },
      { id: "helper", type: "function", name: "helper", file: "cache.ts", startLine: 12 },
    ],
    edges: [{ from: "first", to: "helper", type: "calls" }],
  };
  const name = searchableIdentifier("loadCache");
  assert.equal(name, "loadCache load Cache");
  const seed = { file: "cache.ts", symbolName: name, symbolType: "method", startLine: 3 };
  assert.deepEqual(expandGraphContextDetailed(graph, [seed]).seedNodeIds, []);
  const expanded = expandGraphContextDetailed(graph, [{ ...seed, lexicalSymbolName: name }]);
  assert.deepEqual(expanded.seedNodeIds, ["first"]);
  assert.deepEqual(expanded.nodes.map((node) => node.id), ["helper"]);
  assert.deepEqual(expanded.details[0]?.path, ["first", "helper"]);
  assert.deepEqual(expandGraphContextDetailed(graph, [{ ...seed, startLine: undefined, lexicalSymbolName: name }]).seedNodeIds, []);
  assert.deepEqual(expandGraphContextDetailed(graph, [{ ...seed, lexicalSymbolName: "loadCache unrelated" }]).seedNodeIds, []);
  const raw = expandGraphContextDetailed(graph, [{ ...seed, symbolName: "loadCache" }]);
  assert.deepEqual(raw, expanded);
});

test("CA-01 graph seeds preserve literal multiword names and do not infer a prefix match", () => {
  const graph: CodeGraph = {
    nodes: [
      { id: "operator", type: "function", name: "operator", file: "sample.cpp", startLine: 1 },
      { id: "operator-new", type: "function", name: "operator new", file: "sample.cpp", startLine: 1 },
    ],
    edges: [],
  };
  const name = searchableIdentifier("operator new");
  const seed = { file: "sample.cpp", symbolName: name, lexicalSymbolName: name, symbolType: "function", startLine: 1 };
  assert.deepEqual(expandGraphContextDetailed(graph, [seed]).seedNodeIds, ["operator-new"]);
});

test("CA-01 lexical-only retrieval seeds graph expansion without adding the seed again", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-ca01-lexical-seed-"));
  try {
    await writeFile(path.join(root, "main.ts"), "export function anchorSeed() { return leafTarget(); }\nfunction leafTarget() { return 7; }\n");
    const indexed = await indexRepository(root, { skipGit: true });
    assert.equal(indexed.kind, "published", JSON.stringify(indexed));
    const options = { repoPath: root, topK: 1, graphDepth: 2, graphMaxNodes: 8, tokenBudget: 4000 };
    const inspected = await inspectRetrieval("anchorSeed", options);
    assert.equal(inspected.lexicalResults[0]?.symbolName, searchableIdentifier("anchorSeed"));
    assert.equal(inspected.fusedResults[0]?.symbolName, searchableIdentifier("anchorSeed"));
    assert.equal(inspected.graphExpansion.available, true, inspected.graphExpansion.error);
    assert.equal(inspected.graphExpansion.seedNodeIds.length, 1);
    assert.ok(inspected.graphExpansion.details.some(({ node }) => node.symbolName === "leafTarget"));
    assert.ok(inspected.graphExpansion.details.every(({ node }) => node.symbolName !== "anchorSeed"));
    const repeated = await inspectRetrieval("anchorSeed", { ...options, graphEnabled: false });
    assert.deepEqual(inspected.fusedResults, repeated.fusedResults);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
