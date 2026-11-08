import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";

async function indexSource(source: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ca02-bare-call-"));
  await writeFile(path.join(root, "source.ts"), source);
  const published = await indexRepository(root, { skipGit: true });
  assert.equal(published.kind, "published", JSON.stringify(published));
  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
  return { root, store, graph: store.loadGraph(getRepositoryIdentity(root).id) };
}

test("CA-02 resolves a unique bare lexical target and preserves provenance", async () => {
  const source = [
    "export function target() { return 1; }",
    "export function caller() {",
    "  return target();",
    "}",
  ].join("\n");
  const parsed = extractParsedFacts({ source, filePath: "source.ts", language: "typescript", contentHash: "ca02-diagnostic" });
  if (parsed.kind === "facts") {
    console.log("CA02_SCOPE_FACTS " + JSON.stringify({ symbols: parsed.facts.symbols, scopes: parsed.facts.containmentScopes, calls: parsed.facts.callSites }));
  }
  const { root, store, graph } = await indexSource(source);
  try {
    console.log("CA02_DIAGNOSTICS " + JSON.stringify(store.getGraphResolutionDiagnostics(getRepositoryIdentity(root).id)));
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const calls = graph.edges.filter((edge) => edge.type === "calls");
    const caller = graph.nodes.find((node) => node.type === "function" && node.name === "caller");
    assert.ok(caller);
    const fromCaller = calls.filter((edge) => edge.from === caller.id);
    assert.equal(fromCaller.length, 1, JSON.stringify({ calls, nodes: graph.nodes, coverage: store.getGraphResolutionCoverage(getRepositoryIdentity(root).id) }));
    const target = nodes.get(fromCaller[0]!.to);
    assert.equal(target?.startLine, 1);
    assert.equal(fromCaller[0]!.resolution?.strategy, "lexical-local");
    assert.equal(fromCaller[0]!.resolution?.confidence, "strong");
    assert.ok(fromCaller[0]!.resolution?.evidence.some((item) => item.sourceUnit === "source.ts" && item.startLine === 3));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CA-02 does not fabricate target identity for same-name lexical shadowing", async () => {
  const source = [
    "export function target() { return 1; }",
    "export function outer() {",
    "  function target() { return 2; }",
    "  return target();",
    "}",
    "export function caller() { return target(); }",
  ].join("\n");
  const { root, store, graph } = await indexSource(source);
  try {
    // Graph node identity currently cannot distinguish same-qualified-name symbols.
    // The safe result is unknown/no edge, never a wrong-scope link.
    const calls = graph.edges.filter((edge) => edge.type === "calls");
    assert.equal(calls.length, 0, JSON.stringify(calls));
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("CA-02 does not invent bare calls for parameter shadow, duplicate declarations or missing targets", async () => {
  for (const [label, source] of [
    ["parameter shadow", "function target() {} function outer(target: () => void) { target(); }"],
    ["local binding shadow", "function target() {} function outer() { const target = () => 1; target(); }"],
    ["unbound name", "function outer() { missing(); }"],
    ["ambiguous same-scope", "function target() {} function target() {} function outer() { target(); }"],
  ] as const) {
    const { root, store, graph } = await indexSource(source);
    try {
      assert.equal(graph.edges.filter((edge) => edge.type === "calls").length, 0, label);
    } finally {
      store.close();
      await rm(root, { recursive: true, force: true });
    }
  }
});

test("CA-02 member or computed calls are not reinterpreted as lexical function calls", async () => {
  const { root, store, graph } = await indexSource(
    "function work() {} function outer(receiver: unknown) { (receiver as { work(): void }).work(); }",
  );
  try {
    assert.equal(graph.edges.filter((edge) => edge.type === "calls").length, 0);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
