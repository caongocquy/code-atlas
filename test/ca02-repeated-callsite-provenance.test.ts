import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { mergeEdgeProvenance, MAX_COMPACT_EVIDENCE } from "../src/core/graph/resolver/provenance.js";
import { symbolIdentityKey, symbolIdentity } from "../src/core/graph/resolver/identities.js";
import type { GraphEdge } from "../src/core/graph/types.js";

const initial = [
  "export function target() { return 1; }",
  "export function caller() {",
  "  target();",
  "  target();",
  "  return target();",
  "}",
].join("\n");

async function fixture(source: string): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ca02-multi-call-"));
  await writeFile(path.join(root, "source.ts"), source);
  return root;
}

function readPublished(root: string) {
  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"), { readOnly: true });
  try {
    const graph = store.loadGraph(getRepositoryIdentity(root).id);
    const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
    return graph.edges.filter((edge) => edge.type === "calls").map((edge) => ({
      from: nodes.get(edge.from)?.name,
      to: nodes.get(edge.to)?.name,
      resolution: edge.resolution,
    }));
  } finally {
    store.close();
  }
}

test("CA-02 merges three callsites into a single published calls edge with every source line", async () => {
  const root = await fixture(initial);
  try {
    assert.equal((await indexRepository(root, { skipGit: true })).kind, "published");
    const edges = readPublished(root);
    assert.equal(edges.length, 1, JSON.stringify(edges));
    assert.equal(edges[0]?.from, "caller");
    assert.equal(edges[0]?.to, "target");
    assert.equal(edges[0]?.resolution?.confidence, "strong");
    const evidence = edges[0]?.resolution?.evidence ?? [];
    assert.deepEqual([...new Set(evidence.map((item) => item.startLine))], [3, 4, 5]);
    assert.ok(evidence.every((item) => item.sourceUnit === "source.ts"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("CA-02 bounds evidence deterministically and rejects mixed edge identities", () => {
  const identity = (name: string) => symbolIdentityKey(symbolIdentity({
    repositoryId: "repository", relativePath: "source.ts", language: "typescript",
    kind: "function", qualifiedName: name, discriminator: name,
  }));
  const base = { from: "caller", to: "target", type: "calls" as const };
  const make = (line: number) => ({
    strategy: "lexical-local", confidence: "strong" as const,
    evidence: [{ kind: "resolver", sourceUnit: "source.ts", startLine: line, endLine: line, evidenceId: `call:${line}` }],
    resolutionVersion: "1.2.6", sourceLogicalIdentity: identity("caller"), targetLogicalIdentity: identity("target"),
  });
  let graph: GraphEdge = base;
  for (const line of [14, 11, 10, 12, 13, 10, 16, 19, 18, 15, 17]) {
    graph = mergeEdgeProvenance(graph, make(line));
  }
  const retained = graph.resolution?.evidence ?? [];
  assert.equal(retained.length, MAX_COMPACT_EVIDENCE);
  assert.deepEqual(retained.map((item) => item.startLine), [10, 11, 12, 13, 14, 15, 16, 17]);
  assert.throws(() => mergeEdgeProvenance(graph, {
    ...make(20), targetLogicalIdentity: identity("other"),
  }), /cannot merge provenance/);
  assert.throws(() => mergeEdgeProvenance(graph, {
    ...make(20), resolutionVersion: "old",
  }), /cannot merge provenance/);
});

test("CA-02 refreshes repeated-callsite provenance after incremental edit", async () => {
  const root = await fixture(initial);
  const clean = await fixture(initial);
  const modified = [
    "export function target() { return 1; }",
    "export function caller() {",
    "  target();",
    "  return target();",
    "}",
  ].join("\n");
  try {
    assert.equal((await indexRepository(root, { skipGit: true })).kind, "published");
    await writeFile(path.join(root, "source.ts"), modified);
    await writeFile(path.join(clean, "source.ts"), modified);
    assert.equal((await syncRepository(root, { skipGit: true })).kind, "published");
    assert.equal((await indexRepository(clean, { skipGit: true })).kind, "published");
    const current = readPublished(root);
    assert.deepEqual(current.map((item) => ({ from: item.from, to: item.to, evidence: item.resolution?.evidence })),
      readPublished(clean).map((item) => ({ from: item.from, to: item.to, evidence: item.resolution?.evidence })));
    assert.equal(current.length, 1);
    assert.deepEqual(current[0]?.resolution?.evidence.map((item) => item.startLine), [3, 4]);
  } finally {
    await rm(root, { recursive: true, force: true });
    await rm(clean, { recursive: true, force: true });
  }
});
