import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

const code = [
  "export function target() { return 1; }",
  "export function outer() {",
  "  function target() { return 2; }",
  "  return target();",
  "}",
  "export function caller() { return target(); }",
].join("\n");

async function fixture(source: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ca02-nested-identity-"));
  await writeFile(path.join(root, "source.ts"), source);
  return root;
}

function readGraph(root: string) {
  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"), { readOnly: true });
  try {
    const graph = store.loadGraph(getRepositoryIdentity(root).id);
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    return {
      nodes: graph.nodes.filter((node) => node.type === "function").map((node) => ({
        name: node.name, qualifiedName: node.qualifiedName, line: node.startLine, id: node.id,
      })).sort((a, b) => a.line! - b.line!),
      calls: graph.edges.filter((edge) => edge.type === "calls").map((edge) => ({
        caller: nodes.get(edge.from)?.qualifiedName,
        callee: nodes.get(edge.to)?.qualifiedName,
        targetLine: nodes.get(edge.to)?.startLine,
        strategy: edge.resolution?.strategy,
        confidence: edge.resolution?.confidence,
        evidence: edge.resolution?.evidence.map((item) => [item.sourceUnit, item.startLine]),
      })).sort((a, b) => String(a.caller).localeCompare(String(b.caller))),
    };
  } finally {
    store.close();
  }
}

test("CA-02 nested functions have distinct lexical identities and exact call targets", async () => {
  const facts = extractParsedFacts({ source: code, filePath: "source.ts", language: "typescript", contentHash: "nested-identity" });
  assert.equal(facts.kind, "facts");
  if (facts.kind !== "facts") return;
  assert.deepEqual(facts.facts.symbols.filter((symbol) => symbol.kind === "function")
    .map((symbol) => symbol.declaredQualifiedName), ["target", "outer", "outer.target", "caller"]);

  const root = await fixture(code);
  try {
    assert.equal((await indexRepository(root, { skipGit: true })).kind, "published");
    const graph = readGraph(root);
    assert.equal(new Set(graph.nodes.map((node) => node.id)).size, 4);
    assert.deepEqual(graph.nodes.map((node) => node.qualifiedName), ["target", "outer", "outer.target", "caller"]);
    assert.deepEqual(graph.calls.map(({ caller, callee, targetLine, strategy, confidence }) => ({
      caller, callee, targetLine, strategy, confidence,
    })), [
      { caller: "caller", callee: "target", targetLine: 1, strategy: "lexical-local", confidence: "strong" },
      { caller: "outer", callee: "outer.target", targetLine: 3, strategy: "lexical-local", confidence: "strong" },
    ]);
    assert.ok(graph.calls.every((edge) => edge.evidence?.some((item) => item[0] === "source.ts")));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CA-02 distinct outer functions may each declare an inner function with the same name", async () => {
  const source = [
    "export function alpha() { function work() { return 1; } return work(); }",
    "export function beta() { function work() { return 2; } return work(); }",
  ].join("\n");
  const root = await fixture(source);
  try {
    assert.equal((await indexRepository(root, { skipGit: true })).kind, "published");
    const graph = readGraph(root);
    assert.deepEqual(graph.calls.map((edge) => [edge.caller, edge.callee]), [
      ["alpha", "alpha.work"],
      ["beta", "beta.work"],
    ]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CA-02 nested function graph identity remains stable between clean and incremental sync", async () => {
  const incremental = await fixture(code);
  const clean = await fixture(code);
  try {
    assert.equal((await indexRepository(incremental, { skipGit: true })).kind, "published");
    assert.equal((await indexRepository(clean, { skipGit: true })).kind, "published");
    const first = readGraph(incremental);
    assert.deepEqual(first, readGraph(clean));
    await writeFile(path.join(incremental, "source.ts"), code + "\n// unrelated comment\n");
    assert.equal((await syncRepository(incremental, { skipGit: true })).kind, "published");
    assert.deepEqual(readGraph(incremental), first);
  } finally {
    await rm(incremental, { recursive: true, force: true });
    await rm(clean, { recursive: true, force: true });
  }
});
