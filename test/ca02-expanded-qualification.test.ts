import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import test from "node:test";
import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";

const files: Record<string, string> = {
  "service.ts": "export function fetch() { return 1; }\n",
  "barrel.ts": 'export { fetch as fetchData } from "./service.js";\n',
  "main.ts": [
    'import { fetchData } from "./barrel.js";',
    'class First { work() { return 1; } }',
    'class Second { work() { return 2; } }',
    'function top() { return 1; }',
    'function nested() { function top() { return 2; } top(); }',
    'function direct() { top(); top(); }',
    'function imported() { fetchData(); }',
    'function typedFirst(receiver: First) { receiver.work(); }',
    'function typedSecond(receiver: Second) { receiver.work(); }',
    'function unknown(receiver: unknown) { (receiver as { work(): void }).work(); }',
    'function missing() { notDefined(); }',
    'function shadow(top: () => void) { top(); }',
    'function cross() { nested(); direct(); imported(); }',
    'function annotated() { const service: First = new First(); service.work(); }',
  ].join("\n") + "\n",
};

// Hand-authored labels are intentionally independent from the graph output.
// Each entry represents one source callsite, not a deduplicated edge.
const positives = [
  { line: 5, from: "nested", to: "nested.top" },
  { line: 6, from: "direct", to: "top", count: 2 },
  { line: 7, from: "imported", to: "fetch", targetFile: "service.ts" },
  { line: 8, from: "typedFirst", to: "First.work" },
  { line: 9, from: "typedSecond", to: "Second.work" },
  { line: 13, from: "cross", to: "nested" },
  { line: 13, from: "cross", to: "direct" },
  { line: 13, from: "cross", to: "imported" },
  { line: 14, from: "annotated", to: "First.work" },
] as const;
const forbidden = [
  { from: "nested", to: "top" },
  { from: "typedFirst", to: "Second.work" },
  { from: "typedSecond", to: "First.work" },
  { from: "unknown", to: "First.work" },
  { from: "unknown", to: "Second.work" },
  { from: "missing", to: "top" },
  { from: "shadow", to: "top" },
] as const;

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "ca02-qualification-"));
  for (const [name, source] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), source);
  }
  return root;
}

function observations(root: string) {
  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"), { readOnly: true });
  try {
    const graph = store.loadGraph(getRepositoryIdentity(root).id);
    const byId = new Map(graph.nodes.map((node) => [node.id, node]));
    return graph.edges.filter((edge) => edge.type === "calls").flatMap((edge) => {
      const from = byId.get(edge.from), to = byId.get(edge.to);
      return from && to ? [{
        from: from.qualifiedName ?? from.name,
        to: to.qualifiedName ?? to.name,
        targetFile: to.file,
        lines: [...new Set((edge.resolution?.evidence ?? []).filter((item) => item.sourceUnit === "main.ts").map((item) => item.startLine))].sort((a,b) => a-b),
        confidence: edge.resolution?.confidence,
      }] : [];
    }).sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  } finally { store.close(); }
}

test("CA-02 expanded, separately labeled corpus reports callsite recall and prevents forbidden targets", async () => {
  const root = await createFixture();
  try {
    assert.equal((await indexRepository(root, { skipGit: true })).kind, "published");
    const found = observations(root);
    const hits = positives.filter((expected) => found.some((edge) => edge.from === expected.from && edge.to === expected.to &&
      edge.lines.includes(expected.line) && (!("targetFile" in expected) || edge.targetFile === expected.targetFile)));
    const forbiddenHits = forbidden.filter((candidate) => found.some((edge) => edge.from === candidate.from && edge.to === candidate.to));
    const report = {
      corpus: "ca02-expanded-source-backed",
      labelCount: positives.length,
      hits: hits.length,
      missed: positives.filter((item) => !hits.includes(item)),
      forbiddenHits,
      labeledRecall: hits.length / positives.length,
      labeledPrecision: hits.length + forbiddenHits.length ? hits.length / (hits.length + forbiddenHits.length) : null,
      caveat: "Small author-labeled fixture; not independent repository-wide precision/recall. Duplicate same-line calls only count once.",
    };
    console.log("CA02_EXPANDED_GOLD " + JSON.stringify(report));
    assert.deepEqual(forbiddenHits, [], "name-only or ambiguous resolutions are prohibited");
    assert.ok(hits.length >= 6, "expanded corpus should retain high-signal previously verified patterns");
    assert.ok(found.every((edge) => edge.confidence === "strong" || edge.confidence === "exact"));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("CA-02 expanded corpus clean and incremental semantic edges agree after reexport and code edits", async () => {
  const updated = {
    ...files,
    "service.ts": "export function fetch() { return 2; }\n",
    "main.ts": files["main.ts"]! + "\n// non-semantic comment\n",
  };
  const incremental = await createFixture();
  const clean = await createFixture();
  try {
    assert.equal((await indexRepository(incremental, { skipGit: true })).kind, "published");
    for (const [name, source] of Object.entries(updated)) {
      await writeFile(path.join(incremental, name), source);
      await writeFile(path.join(clean, name), source);
    }
    assert.equal((await syncRepository(incremental, { skipGit: true })).kind, "published");
    assert.equal((await indexRepository(clean, { skipGit: true })).kind, "published");
    assert.deepEqual(observations(incremental), observations(clean));
  } finally {
    await rm(incremental, { recursive: true, force: true });
    await rm(clean, { recursive: true, force: true });
  }
});
