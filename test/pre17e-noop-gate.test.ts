import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { indexRepository, syncRepository, type IndexPipelineResult } from "../src/core/indexing/index-pipeline.service.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import type { ScipIndexer } from "../src/core/indexing/scip-indexer.types.js";
import type { VectorStore } from "../src/core/semantic/vector-store.js";

function published(value: Awaited<ReturnType<typeof syncRepository>>): IndexPipelineResult {
  assert.equal(value.kind, "published", value.kind === "failed" ? value.failure.message : "");
  return value as IndexPipelineResult;
}
async function fixture(incomplete = false) {
  const root = await fs.mkdtemp(path.join(tmpdir(), "atlas-noop-gate-"));
  await fs.writeFile(path.join(root, "App.tsx"), incomplete
    ? 'import { missing } from "./missing.js"; export function App({ View }) { return <View />; }\n'
    : "export function App() { return 1; }\n");
  await fs.writeFile(path.join(root, "stable.ts"), "export function stable() { return 2; }\n");
  return root;
}
function semantic() {
  const embeddingProvider = { id: "model-one", version: "revision-one", dimensions: 2,
    isAvailable: async () => true, embedBatch: async (texts: string[]) => texts.map(() => [1, 0]) };
  const vectorStore: VectorStore = { id: "vectors-one", isAvailable: async () => true,
    ensureCollection: async () => {}, search: async () => [], count: async () => 0,
    getIndexedFileStates: async () => new Map(), upsert: async () => {}, deletePointIds: async () => {}, deleteFile: async () => {} };
  return { embeddingProvider, vectorStore };
}
function snapshot(root: string) {
  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
  const id = getRepositoryIdentity(root).id;
  try {
    const db = new DatabaseSync(path.join(root, ".codeatlas", "atlas.db"), { readOnly: true });
    try { return { generations: (db.prepare("SELECT count(*) AS n FROM index_generations").get() as { n: number }).n,
      manifest: store.getGenerationManifest(id), framework: store.loadFramework(id),
      coverage: store.getGraphResolutionCoverage(id), diagnostics: store.getGraphResolutionDiagnostics(id),
      states: [...store.getFileCapabilityStates(id, "graph"), ...store.getFileCapabilityStates(id, "lexical"), ...store.getFileCapabilityStates(id, "semantic")] }; }
    finally { db.close(); }
  } finally { store.close(); }
}
function zeroWork(result: IndexPipelineResult) {
  assert.equal(result.generationReused, true);
  assert.deepEqual(result.changes, { addedFiles: [], changedFiles: [], deletedFiles: [], candidateFiles: [] });
  for (const key of ["filesParsed", "factCacheHits", "factCacheMisses", "filesResolved", "frameworkFilesResolved", "scipRuns", "lexicalFilesUpdated", "lexicalDocumentsInserted", "lexicalDocumentsDeleted", "lexicalDocumentsReused", "semanticUnitsEmbedded", "semanticVectorsWritten", "semanticVectorsCopied", "graphRowsInserted", "graphRowsCopied", "frameworkRowsInserted", "frameworkRowsCopied", "metadataRowsUpdated", "metadataRowsDeleted", "storageTransactions"] as const) {
    assert.equal(result.counters[key], 0, key);
  }
}
for (const incomplete of [false, true]) test(`no-op preserves published ${incomplete ? "incomplete unresolved" : "complete"} evidence and writes nothing`, async () => {
  const root = await fixture(incomplete), semanticProviders = semantic();
  try {
    const options = { skipGit: true, includeSemantic: true, semanticProviders };
    const first = published(await indexRepository(root, options));
    const before = snapshot(root);
    if (incomplete) {
      assert.ok(first.plan.reasons.includes("unresolved_import_ownership"));
      assert.equal(before.framework?.complete, false);
      assert.ok(before.framework?.diagnostics.some(d => d.code === "framework_construct_unsupported"));
    }
    for (let i = 0; i < 2; i++) {
      const unchanged = published(await syncRepository(root, options));
      zeroWork(unchanged);
      assert.equal(unchanged.generationId, first.generationId);
      assert.deepEqual(snapshot(root), before);
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("actual source edit outside unresolved ownership remains bounded", async () => {
  const root = await fixture(true);
  try {
    published(await indexRepository(root, { skipGit: true }));
    await fs.writeFile(path.join(root, "stable.ts"), "export function stable() { return 3; }\n");
    const changed = published(await syncRepository(root, { skipGit: true }));
    assert.equal(changed.generationReused, undefined);
    assert.ok(!changed.plan.reasons.includes("unresolved_import_ownership"));
    assert.equal(changed.plan.fullGraphResolution, false);
    assert.equal(changed.counters.filesResolved, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("provider/model/revision and vector-store changes prevent the no-op shortcut", async () => {
  const root = await fixture(true), semanticProviders = semantic();
  try {
    const options = { skipGit: true, includeSemantic: true, semanticProviders };
    let previous = published(await indexRepository(root, options));
    for (const change of [() => { semanticProviders.embeddingProvider.id = "model-two"; },
      () => { semanticProviders.embeddingProvider.version = "revision-two"; },
      () => { semanticProviders.vectorStore.id = "vectors-two"; }]) {
      change();
      const next = published(await syncRepository(root, options));
      assert.notEqual(next.generationId, previous.generationId);
      assert.equal(next.semantic?.embeddedSymbols, 2);
      previous = next;
    }
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("every compatibility version domain prevents the shortcut", async () => {
  const root = await fixture();
  try {
    for (const domain of [...Object.keys(CURRENT_INDEX_VERSION_DOMAINS), "reliabilityVersion"]) {
      const first = published(await indexRepository(root, { skipGit: true }));
      const db = new DatabaseSync(path.join(root, ".codeatlas", "atlas.db"));
      try {
        for (const table of ["index_manifests", "index_generations"]) {
          const column = table === "index_generations" ? "id" : "generation_id";
          const row = db.prepare(`SELECT versions_json FROM ${table} WHERE ${column} = ?`).get(first.generationId) as { versions_json: string };
          const versions = JSON.parse(row.versions_json); versions[domain] = "old-version";
          db.prepare(`UPDATE ${table} SET versions_json = ? WHERE ${column} = ?`).run(JSON.stringify(versions), first.generationId);
        }
      } finally { db.close(); }
      assert.notEqual(published(await syncRepository(root, { skipGit: true })).generationId, first.generationId, domain);
    }
    const first = published(await indexRepository(root, { skipGit: true }));
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    store.setVersion(getRepositoryIdentity(root).id, "graph", "old-version"); store.close();
    assert.notEqual(published(await syncRepository(root, { skipGit: true })).generationId, first.generationId);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("config, excludes and SCIP tool/protocol inputs prevent the shortcut", async () => {
  const root = await fixture();
  let version = "1";
  const scipIndexer: ScipIndexer = { discover: async () => ({ status: "ready", tool: { version, source: "path", executablePath: "fixture" } }), index: async () => [] };
  try {
    const options = { skipGit: true, scipIndexer };
    let previous = published(await indexRepository(root, options));
    for (const edit of [() => fs.writeFile(path.join(root, "tsconfig.json"), '{"compilerOptions":{"strict":true}}'),
      () => fs.writeFile(path.join(root, "codeatlas.config.json"), '{"version":1,"excludes":["stable.ts"]}'),
      () => fs.writeFile(path.join(root, ".gitignore"), "ignored.md\n"),
      () => fs.writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n")]) {
      await edit(); const next = published(await syncRepository(root, options));
      assert.notEqual(next.generationId, previous.generationId); previous = next;
    }
    version = "2";
    const toolChanged = published(await syncRepository(root, options));
    assert.equal(toolChanged.counters.scipRuns, 1);
    assert.notEqual(toolChanged.generationId, previous.generationId);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("missing framework snapshot requires recovery even with unchanged source", async () => {
  const root = await fixture();
  try {
    const first = published(await indexRepository(root, { skipGit: true }));
    const db = new DatabaseSync(path.join(root, ".codeatlas", "atlas.db"));
    db.prepare("DELETE FROM generation_framework_state WHERE generation_id = ?").run(first.generationId); db.close();
    assert.notEqual(published(await syncRepository(root, { skipGit: true })).generationId, first.generationId);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("new source inputs retain bounded resolution when the published topology is complete", async () => {
  const root = await fixture();
  try {
    published(await indexRepository(root, { skipGit: true }));
    await fs.writeFile(path.join(root, "new.ts"), "export function added() { return 3; }\n");
    const added = published(await syncRepository(root, { skipGit: true }));
    assert.deepEqual(added.changes.addedFiles, ["new.ts"]);
    assert.equal(added.counters.filesResolved, 1);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
