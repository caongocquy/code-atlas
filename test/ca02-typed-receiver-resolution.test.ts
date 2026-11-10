import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

async function fixture(source: string) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ca02-typed-receiver-"));
  await writeFile(path.join(root, "source.ts"), source);
  return root;
}

function calls(root: string) {
  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"), { readOnly: true });
  try {
    const graph = store.loadGraph(getRepositoryIdentity(root).id);
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    return graph.edges.filter((edge) => edge.type === "calls").map((edge) => ({
      from: nodes.get(edge.from)?.qualifiedName,
      to: nodes.get(edge.to)?.qualifiedName,
      line: edge.resolution?.evidence[0]?.startLine,
      strategy: edge.resolution?.strategy,
    })).sort((a, b) => String(a.from).localeCompare(String(b.from)) || String(a.to).localeCompare(String(b.to)));
  } finally { store.close(); }
}

test("CA-02 resolves typed receiver to owning method and excludes same-name decoy", async () => {
  const source = [
    "class First { work() { return 1; } }",
    "class Second { work() { return 2; } }",
    "function invokeKnown(receiver: First) { return receiver.work(); }",
  ].join("\n");
  const root = await fixture(source);
  try {
    assert.equal((await indexRepository(root, { skipGit: true })).kind, "published");
    assert.deepEqual(calls(root).map((edge) => [edge.from, edge.to, edge.strategy]),
      [["invokeKnown", "First.work", "receiver-member"]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CA-02 rejects structurally asserted, unknown and shadowed receivers", async () => {
  const sources = [
    'class First { work() {} } class Second { work() {} } function call(receiver: unknown) { return (receiver as { work(): unknown }).work(); }',
    'class First { work() {} } function call(receiver: unknown) { return receiver.work(); }',
    'class First { work() {} } function call(receiver: First) { const x: unknown = receiver; return x.work(); }',
    'class First { work() {} } class Second { work() {} } function call(receiver: First | Second) { return receiver.work(); }',
  ];
  for (const source of sources) {
    const root = await fixture(source);
    try {
      assert.equal((await indexRepository(root, { skipGit: true })).kind, "published");
      assert.deepEqual(calls(root), []);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test("CA-02 typed receiver incremental graph matches clean indexing", async () => {
  const source = [
    "class First { work() { return 1; } }",
    "class Second { work() { return 2; } }",
    "function call(receiver: First) { return receiver.work(); }",
  ].join("\n");
  const incremental = await fixture(source);
  const clean = await fixture(source);
  try {
    assert.equal((await indexRepository(incremental, { skipGit: true })).kind, "published");
    const expected = calls(incremental);
    await writeFile(path.join(incremental, "source.ts"), source + "\n// non-semantic edit\n");
    await writeFile(path.join(clean, "source.ts"), source + "\n// non-semantic edit\n");
    assert.equal((await syncRepository(incremental, { skipGit: true })).kind, "published");
    assert.equal((await indexRepository(clean, { skipGit: true })).kind, "published");
    assert.deepEqual(calls(incremental), calls(clean));
    assert.deepEqual(calls(incremental), expected);
  } finally {
    await rm(incremental, { recursive: true, force: true });
    await rm(clean, { recursive: true, force: true });
  }
});
