import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import * as pipeline from "../src/core/indexing/index-pipeline.service.js";
import type { IndexPipelineResult } from "../src/core/indexing/index-pipeline.service.js";
import type { VectorStore } from "../src/core/semantic/vector-store.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "atlas-pre17e-"));
  await fs.writeFile(path.join(root, "a.ts"), "export function a() { return 1; }\n");
  await fs.writeFile(path.join(root, "b.ts"), "export function b() { return 2; }\n");
  return root;
}
function providers() {
  let embedded = 0;
  const embeddingProvider = { id: "fixture", version: "1", dimensions: 2,
    isAvailable: async () => true,
    embedBatch: async (texts: string[]) => { embedded += texts.length; return texts.map(() => [1, 0]); },
  };
  const vectorStore: VectorStore = { id: "fixture", isAvailable: async () => true,
    ensureCollection: async () => {}, search: async () => [], count: async () => 0,
    getIndexedFileStates: async () => new Map(), upsert: async () => {},
    deletePointIds: async () => {}, deleteFile: async () => {},
  };
  return { embeddingProvider, vectorStore, embedded: () => embedded };
}
function result(value: Awaited<ReturnType<typeof pipeline.indexRepository>>): IndexPipelineResult {
  assert.equal(value.kind, "published", value.kind === "failed" ? value.failure.message : "");
  return value as IndexPipelineResult;
}
function generationCount(root: string) {
  const db = new DatabaseSync(path.join(root, ".codeatlas", "atlas.db"));
  try { return (db.prepare("SELECT count(*) AS n FROM index_generations").get() as {n: number}).n; }
  finally { db.close(); }
}
test("true no-op reuses generation and skips parse/resolver/framework/lexical/semantic writes", async () => {
  const root = await fixture(), semanticProviders = providers();
  try {
    const options = { skipGit: true, includeSemantic: true, semanticProviders, diagnosticTimings: true };
    const first = result(await pipeline.indexRepository(root, options));
    const before = semanticProviders.embedded(), generations = generationCount(root);
    const messages: string[] = [];
    const current = result(await pipeline.syncRepository(root, { ...options, progress: {
      update: (message) => messages.push(message),
      run: async (title, work) => { messages.push(title); return work({ update() {}, setProgress() {} }); },
    } }));
    assert.equal(current.generationId, first.generationId);
    assert.equal(generationCount(root), generations);
    assert.equal(semanticProviders.embedded(), before);
    assert.equal(current.counters.filesParsed, 0);
    assert.equal(current.counters.filesResolved, 0);
    assert.equal(current.counters.frameworkFilesResolved, 0);
    assert.deepEqual(current.changes, { addedFiles: [], changedFiles: [], deletedFiles: [], candidateFiles: [] });
    assert.ok(!messages.some((message) => /Resolving|Parsing|Writing/.test(message)));
    assert.equal(current.phaseTimingsMs?.lexicalPersistence ?? 0, 0);
    const secondIndex = result(await pipeline.indexRepository(root, options));
    assert.equal(secondIndex.generationId, first.generationId);
    assert.equal(secondIndex.graph.fullRebuild, false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("one source edit embeds one unit and copies unchanged lexical/vector partitions", async () => {
  const root = await fixture(), semanticProviders = providers();
  try {
    const options = { skipGit: true, includeSemantic: true, semanticProviders };
    result(await pipeline.indexRepository(root, options));
    const before = semanticProviders.embedded();
    await fs.writeFile(path.join(root, "a.ts"), "export function a() { return 3; }\n");
    const delta = result(await pipeline.syncRepository(root, options));
    assert.equal(delta.counters.filesParsed, 1);
    assert.equal(delta.counters.filesResolved, 1);
    assert.equal(delta.lexical.indexedFiles, 1);
    assert.equal(semanticProviders.embedded() - before, 1);
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      const id = getRepositoryIdentity(root).id;
      assert.equal(store.searchLexical(id, "b", 10).some((row) => row.file === "b.ts"), true);
      assert.equal(store.searchSemanticVectors(id, [1, 0], 10).length, 2);
      assert.equal(store.getFileCapabilityStates(id, "semantic").get("a.ts")?.fileHash,
        store.getGenerationManifest(id)?.files.find((file) => file.relativePath === "a.ts")?.contentHash);
    } finally { store.close(); }
    semanticProviders.embeddingProvider.version = "2";
    const switched = result(await pipeline.syncRepository(root, options));
    assert.equal(switched.semantic?.embeddedSymbols, 2);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("35 non-parser files do not become phantom additions and new configs remain visible", async () => {
  const root = await fixture();
  try {
    for (let index = 0; index < 35; index++) await fs.writeFile(path.join(root, `note-${index}.md`), "notes\n");
    result(await pipeline.indexRepository(root, { skipGit: true }));
    const current = result(await pipeline.syncRepository(root, { skipGit: true }));
    assert.deepEqual(current.changes.addedFiles, []);
    assert.deepEqual(current.changes.changedFiles, []);
    await fs.writeFile(path.join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true}}');
    const added = result(await pipeline.syncRepository(root, { skipGit: true }));
    assert.deepEqual(added.changes.addedFiles, ["tsconfig.json"]);
    const next = result(await pipeline.syncRepository(root, { skipGit: true }));
    assert.deepEqual(next.changes.addedFiles, []);
    assert.deepEqual(next.changes.changedFiles, []);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("explicit reindex forces source regeneration; delete removes vector and lexical partitions", async () => {
  const root = await fixture(), semanticProviders = providers();
  try {
    const options = { skipGit: true, includeSemantic: true, semanticProviders };
    result(await pipeline.indexRepository(root, options));
    assert.equal(typeof pipeline.reindexRepository, "function");
    const rebuilt = result(await pipeline.reindexRepository(root, options));
    assert.equal(rebuilt.graph.fullRebuild, true);
    assert.equal(rebuilt.counters.filesParsed, 2);
    assert.equal(rebuilt.semantic?.embeddedSymbols, 2);
    await fs.rm(path.join(root, "b.ts"));
    result(await pipeline.syncRepository(root, options));
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      const id = getRepositoryIdentity(root).id;
      assert.equal(store.searchSemanticVectors(id, [1, 0], 10).length, 1);
      assert.equal(store.searchLexical(id, "b", 10).some((row) => row.file === "b.ts"), false);
    } finally { store.close(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("changed file reuses embeddings of unchanged symbols while refreshing ranges and generation", async () => {
  const root = await fixture(), semanticProviders = providers();
  try {
    await fs.writeFile(path.join(root, "a.ts"), "export function a() { return 1; }\nexport function stable() { return 4; }\n");
    const options = { skipGit: true, includeSemantic: true, semanticProviders };
    result(await pipeline.indexRepository(root, options));
    const before = semanticProviders.embedded();
    await fs.writeFile(path.join(root, "a.ts"), "\nexport function a() { return 9; }\nexport function stable() { return 4; }\n");
    const delta = result(await pipeline.syncRepository(root, options));
    assert.equal(semanticProviders.embedded() - before, 1);
    assert.equal(delta.semantic?.embeddedSymbols, 1);
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      const results = store.searchSemanticVectors(getRepositoryIdentity(root).id, [1, 0], 10);
      assert.equal(results.length, 3);
      assert.equal(results.find((row) => row.payload?.symbolName === "stable")?.payload?.startLine, 3);
    } finally { store.close(); }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("delta tracks re-export dependents and matches forced rebuild after topology change", async () => {
  const root = await fixture();
  try {
    await fs.writeFile(path.join(root, "barrel.ts"), 'export { a } from "./a.js";\n');
    await fs.writeFile(path.join(root, "consumer.ts"), 'import { a } from "./barrel.js"; export function run() { return a(); }\n');
    result(await pipeline.indexRepository(root, { skipGit: true }));
    await fs.writeFile(path.join(root, "a.ts"), "export function replacement() { return 3; }\n");
    const delta = result(await pipeline.syncRepository(root, { skipGit: true }));
    assert.ok(delta.incrementalPlan?.graph.dirtyPaths.includes("consumer.ts"));
    const snapshot = () => {
      const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
      try {
        const graph = store.loadGraph(getRepositoryIdentity(root).id);
        return JSON.stringify({ nodes: graph.nodes.sort((a,b) => a.id.localeCompare(b.id)),
          edges: graph.edges.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))) });
      } finally { store.close(); }
    };
    const incremental = snapshot();
    result(await pipeline.reindexRepository(root, { skipGit: true }));
    assert.equal(snapshot(), incremental);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});


test("independent resolver roots do not exhaust a generation-wide budget", async () => {
  const root = await fixture();
  try {
    for (let i = 0; i < 64; i++) await fs.writeFile(path.join(root, `chain-${i}.ts`),
      `${i ? `import { f${i-1} } from "./chain-${i-1}.js";\n` : ""}export function f${i}() { return ${i ? `f${i-1}() + 1` : "1"}; }\n`);
    result(await pipeline.indexRepository(root, { skipGit: true }));
    const diagnostics = () => {
      const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
      try { return store.getGraphResolutionDiagnostics(getRepositoryIdentity(root).id); }
      finally { store.close(); }
    };
    assert.ok(!diagnostics().some((d) => "reason" in d && d.reason === "candidate_expansion_limit"));
    const activated = result(await pipeline.syncRepository(root, { skipGit: true, includeSemantic: true, semanticProviders: providers() }));
    assert.equal(activated.counters.filesResolved, 0);
    assert.equal(activated.incrementalPlan?.graph.mode, "reuse");
    await fs.writeFile(path.join(root, "chain-31.ts"), 'import { f30 } from "./chain-30.js"; export function f31() { return f30() + 101; }\n');
    const delta = result(await pipeline.syncRepository(root, { skipGit: true }));
    assert.ok(!delta.plan.reasons.includes("dependency_provenance_incomplete"));
    assert.equal(delta.plan.fullGraphResolution, false);
    assert.equal(delta.counters.filesResolved, 33);
    const before = diagnostics();
    result(await pipeline.reindexRepository(root, { skipGit: true }));
    assert.deepEqual(diagnostics(), before);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
