import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import type { CodeGraph } from "../src/core/graph/types.js";

type Expectation = { file: string; line: number; caller: string; callee: string | null; kind: "expected" | "unresolved" };
type Forbidden = { caller: string; callee: string };
type Gold = { expectations: Expectation[]; forbidden: Forbidden[] };
const fixturePath = fileURLToPath(new URL("./fixtures/ca02-edge-audit/", import.meta.url));
const sources = ["source.ts", "reexport.ts", "consumer.ts"] as const;

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "ca02-final-"));
  for (const file of sources) await writeFile(path.join(root, file), await readFile(path.join(fixturePath, file)));
  return root;
}

function readGraph(root: string): CodeGraph {
  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"), { readOnly: true });
  try { return store.loadGraph(getRepositoryIdentity(root).id); }
  finally { store.close(); }
}

function callObservations(graph: CodeGraph) {
  const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
  return graph.edges.filter((edge) => edge.type === "calls").flatMap((edge) => {
    const caller = nodes.get(edge.from);
    const callee = nodes.get(edge.to);
    return caller && callee ? [{
      caller: caller.qualifiedName ?? caller.name,
      callee: callee.qualifiedName ?? callee.name,
      calleeFile: callee.file,
      strategy: edge.resolution?.strategy ?? null,
      confidence: edge.resolution?.confidence ?? null,
      sites: (edge.resolution?.evidence ?? []).map((item) => ({
        file: item.sourceUnit, line: item.startLine, kind: item.kind,
      })).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.kind.localeCompare(b.kind)),
    }] : [];
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

function matches(observation: ReturnType<typeof callObservations>[number], expected: Expectation): boolean {
  return observation.caller === expected.caller && observation.callee === expected.callee
    && observation.sites.some((site) => site.file === expected.file && site.line === expected.line);
}

test("CA-02 gold oracle has source-backed unique labeled callsites", async () => {
  const gold = JSON.parse(await readFile(path.join(fixturePath, "gold.json"), "utf8")) as Gold;
  assert.equal(gold.expectations.filter((entry) => entry.kind === "expected").length, 5);
  const seen = new Set<string>();
  for (const entry of gold.expectations) {
    const line = (await readFile(path.join(fixturePath, entry.file), "utf8")).split("\n")[entry.line - 1];
    assert.ok(line?.includes("("), JSON.stringify(entry));
    const key = `${entry.file}:${entry.line}`;
    assert.equal(seen.has(key), false);
    seen.add(key);
  }
});

test("CA-02 measures source/line-aware gold precision and recall without hiding remaining misses", async () => {
  const root = await fixture();
  try {
    const result = await indexRepository(root, { skipGit: true });
    assert.equal(result.kind, "published", JSON.stringify(result));
    const gold = JSON.parse(await readFile(path.join(fixturePath, "gold.json"), "utf8")) as Gold;
    const observations = callObservations(readGraph(root));
    const positives = gold.expectations.filter((entry) => entry.kind === "expected" && entry.callee !== null);
    const hits = positives.filter((expected) => observations.some((item) => matches(item, expected)));
    const misses = positives.filter((expected) => !observations.some((item) => matches(item, expected)));
    const forbiddenHits = gold.forbidden.filter((entry) => observations.some((item) =>
      item.caller === entry.caller && (entry.callee === "source.ts:target"
        ? item.callee === "target" && item.calleeFile === "source.ts"
        : item.callee === entry.callee)));
    const reported = {
      baseline: { labeledPositives: 5, hits: 0, recall: 0, precision: null },
      current: {
        labeledPositives: positives.length, hits: hits.length, misses,
        forbiddenHits, recall: hits.length / positives.length,
        labeledPrecision: hits.length + forbiddenHits.length
          ? hits.length / (hits.length + forbiddenHits.length) : null,
      },
      observations,
      caveat: "Small fixed oracle; unlabeled predictions are not counted as global precision/recall.",
    };
    console.log("CA02_FINAL_GOLD " + JSON.stringify(reported));
    // Wrong-scope or forbidden edges are a correctness regression even when recall is partial.
    assert.deepEqual(forbiddenHits, []);
    assert.equal(hits.length, positives.length, "CA-02 typed receiver must close the last gold miss: " + JSON.stringify(misses));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CA-02 clean and incremental graphs retain the same resolved callsite semantics", async () => {
  const incremental = await fixture();
  const clean = await fixture();
  try {
    assert.equal((await indexRepository(incremental, { skipGit: true })).kind, "published");
    const oldObservations = callObservations(readGraph(incremental));
    const original = await readFile(path.join(incremental, "consumer.ts"), "utf8");
    const changed = original + "\n// CA-02 validation-only comment\n";
    await writeFile(path.join(incremental, "consumer.ts"), changed);
    await writeFile(path.join(clean, "consumer.ts"), changed);
    assert.equal((await syncRepository(incremental, { skipGit: true })).kind, "published");
    assert.equal((await indexRepository(clean, { skipGit: true })).kind, "published");
    const updated = callObservations(readGraph(incremental));
    assert.deepEqual(updated, callObservations(readGraph(clean)));
    assert.deepEqual(updated, oldObservations);
  } finally {
    await rm(incremental, { recursive: true, force: true });
    await rm(clean, { recursive: true, force: true });
  }
});
