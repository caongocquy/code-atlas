import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

async function indexSource(source: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ca02-bare-call-"));
  await writeFile(path.join(root, "source.ts"), source);
  const published = await indexRepository(root, { skipGit: true });
  assert.equal(published.kind, "published", JSON.stringify(published));
  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
  return { root, store, graph: store.loadGraph(getRepositoryIdentity(root).id) };
}

test("CA-02 resolves bare lexical calls with innermost shadowing and provenance", async () => {
  const source = [
    "export function target() { return 1; }",
    "export function outer() {",
    "  function target() { return 2; }",
    "  return target();",
    "}",
    "export function caller() {",
    "  return target();",
    "}",
  ].join("\n");
  const { root, store, graph } = await indexSource(source);
  try {
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    const calls = graph.edges.filter((edge) => edge.type === "calls");
    const outer = graph.nodes.find((node) => node.type === "function" && node.name === "outer");
    const caller = graph.nodes.find((node) => node.type === "function" && node.name === "caller");
    assert.ok(outer);
    assert.ok(caller);
    const fromOuter = calls.filter((edge) => edge.from === outer.id);
    const fromCaller = calls.filter((edge) => edge.from === caller.id);
    assert.equal(fromOuter.length, 1, JSON.stringify(calls));
    assert.equal(fromCaller.length, 1, JSON.stringify(calls));
    const inner = nodes.get(fromOuter[0]!.to);
    const topLevel = nodes.get(fromCaller[0]!.to);
    assert.equal(inner?.startLine, 3, JSON.stringify({ inner, calls }));
    assert.equal(topLevel?.startLine, 1, JSON.stringify({ topLevel, calls }));
    for (const edge of [fromOuter[0]!, fromCaller[0]!]) {
      assert.equal(edge.resolution?.strategy, "lexical-local");
      assert.equal(edge.resolution?.confidence, "strong");
      assert.ok(edge.resolution?.evidence.some((item) => item.sourceUnit === "source.ts"));
    }
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
