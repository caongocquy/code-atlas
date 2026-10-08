import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { DatabaseSync } from "node:sqlite";
import { execFileSync } from "node:child_process";
import test from "node:test";
import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { embeddingProviderIdentity } from "../src/core/semantic/provider-identity.js";
import type { EmbeddingProvider } from "../src/core/semantic/embedding-provider.js";
import type { VectorStore } from "../src/core/semantic/vector-store.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { resolveRepositoryExcludes, scanRepo } from "../src/core/repository/repository-files.js";
import { createOpenAICompatibleEmbeddingProvider } from "../src/infrastructure/semantic/openai-compatible-embedding-provider.js";

const vectorStore: VectorStore = { id: "p2-vectors", isAvailable: async () => true,
  ensureCollection: async () => {}, search: async () => [], count: async () => 0,
  getIndexedFileStates: async () => new Map(), upsert: async () => {}, deletePointIds: async () => {}, deleteFile: async () => {} };
async function fixture(files: Record<string, string>) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "atlas-p2-"));
  for (const [file, content] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true });
    await fs.writeFile(path.join(root, file), content);
  }
  return root;
}
function persisted(root: string) {
  const store = new AtlasStore(path.join(root, ".codeatlas/atlas.db"), { readOnly: true });
  const id = getRepositoryIdentity(root).id;
  try { return { points: store.getActiveSemanticPoints(id, ["a.ts", "b.ts"]), states: [...store.getFileCapabilityStates(id, "semantic").values()] }; }
  finally { store.close(); }
}
function semanticOnly(result: Awaited<ReturnType<typeof syncRepository>>) {
  assert.equal(result.kind, "published", result.kind === "failed" ? result.failure.message : "");
  if (result.kind !== "published") throw new Error("publication required");
  assert.equal(result.counters.filesParsed, 0);
  assert.equal(result.counters.filesResolved, 0);
  assert.equal(result.counters.lexicalFilesUpdated, 0);
  assert.equal(result.counters.frameworkFilesResolved, 0);
  assert.equal(result.counters.semanticUnitsEmbedded, 2);
  return result;
}
const sources = { "a.ts": "export function a() { return 1; }\n", "b.ts": "export function b() { return 2; }\n" };

test("provider tuples with legacy delimiter collisions have deterministic distinct identities", () => {
  const a = { id: "embed@variant", version: "v1", dimensions: 2 };
  const b = { id: "embed", version: "variant@v1", dimensions: 2 };
  assert.notEqual(embeddingProviderIdentity(a), embeddingProviderIdentity(b));
  assert.equal(embeddingProviderIdentity(a), embeddingProviderIdentity({ ...a }));
  assert.notEqual(embeddingProviderIdentity(a), [a.id, a.version, a.dimensions].join("@"));
  assert.notEqual(embeddingProviderIdentity(a), embeddingProviderIdentity({ ...a, dimensions: 3 }));
  const withOptional: EmbeddingProvider = { ...a, isAvailable: async () => true, embedBatch: async () => [], countTokens: async () => 1 };
  assert.equal(embeddingProviderIdentity(a), embeddingProviderIdentity(withOptional));
  const moduleUrl = new URL("../src/core/semantic/provider-identity.ts", import.meta.url).href;
  const script = `import { embeddingProviderIdentity } from ${JSON.stringify(moduleUrl)}; process.stdout.write(embeddingProviderIdentity(${JSON.stringify(a)}));`;
  for (let i = 0; i < 2; i++) assert.equal(execFileSync(process.execPath,
    ["--import", "tsx/esm", "--input-type=module", "-e", script], { encoding: "utf8" }), embeddingProviderIdentity(a));
});

test("switching colliding providers replaces persisted vectors without graph or lexical rebuild", async () => {
  const root = await fixture(sources); let calls = 0;
  const provider = { id: "embed@variant", version: "v1", dimensions: 2,
    isAvailable: async () => true, embedBatch: async (texts: string[]) => { calls += texts.length; return texts.map(() => [1, 0]); } };
  const options = { skipGit: true, includeSemantic: true, semanticProviders: { embeddingProvider: provider, vectorStore } };
  try {
    const first = await indexRepository(root, options); assert.equal(first.kind, "published");
    assert.equal(calls, 2); assert.ok(persisted(root).points.every(p => p.vector[0] === 1));
    provider.id = "embed"; provider.version = "variant@v1";
    provider.embedBatch = async texts => { calls += texts.length; return texts.map(() => [0, 1]); };
    const second = semanticOnly(await syncRepository(root, options));
    assert.notEqual(second.generationId, first.kind === "published" ? first.generationId : undefined);
    assert.equal(calls, 4);
    const reopened = persisted(root); assert.equal(reopened.points.length, 2);
    assert.ok(reopened.points.every(p => p.vector[0] === 0 && p.vector[1] === 1));
    assert.ok(reopened.states.every(s => s.providerIdentity === embeddingProviderIdentity(provider)));
    const noop = await syncRepository(root, options); assert.equal(noop.kind, "published");
    if (noop.kind === "published") { assert.equal(noop.generationReused, true); assert.equal(noop.generationId, second.generationId); assert.equal(noop.counters.storageTransactions, 0); }
    assert.equal(calls, 4); assert.deepEqual(persisted(root), reopened);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

for (const builtin of [false, true]) test(`legacy persisted ${builtin ? "built-in" : "custom"} identity forces semantic-only refresh`, async () => {
  const root = await fixture(sources), originalFetch = globalThis.fetch; let calls = 0;
  globalThis.fetch = async (_input, init) => {
    const texts = JSON.parse(String(init?.body)).input as string[]; calls += texts.length;
    return new Response(JSON.stringify({ data: texts.map((_, index) => ({ index, embedding: [0, 1] })) }), { status: 200 });
  };
  const provider: EmbeddingProvider = builtin
    ? createOpenAICompatibleEmbeddingProvider({ type: "openai-compatible", baseUrl: "https://review.invalid/v1", model: "test-model", dimensions: 2 })
    : { id: "embed@variant", version: "v1", dimensions: 2, isAvailable: async () => true, embedBatch: async texts => { calls += texts.length; return texts.map(() => [0, 1]); } };
  const options = { skipGit: true, includeSemantic: true, semanticProviders: { embeddingProvider: provider, vectorStore } };
  try {
    const first = await indexRepository(root, options); assert.equal(first.kind, "published");
    const db = new DatabaseSync(path.join(root, ".codeatlas/atlas.db"));
    try { db.prepare("UPDATE file_capability_state SET provider_identity = ? WHERE capability = 'semantic'").run([provider.id, provider.version, provider.dimensions].join("@")); }
    finally { db.close(); }
    const before = calls, refreshed = semanticOnly(await syncRepository(root, options));
    assert.equal(calls - before, 2);
    assert.notEqual(refreshed.generationId, first.kind === "published" ? first.generationId : undefined);
    assert.ok(persisted(root).states.every(s => s.providerIdentity === embeddingProviderIdentity(provider)));
    const noop = await syncRepository(root, options); assert.equal(noop.kind, "published");
    if (noop.kind === "published") assert.equal(noop.generationReused, true);
    assert.equal(calls - before, 2);
  } finally { globalThis.fetch = originalFetch; await fs.rm(root, { recursive: true, force: true }); }
});

for (const mixed of [false, true]) test(`Python ${mixed ? "mixed-stack" : "pyproject"} excludes build output consistently across scan and sync`, async () => {
  const ignore = "# user rule\nuser-output/\n";
  const root = await fixture({ "pyproject.toml": '[project]\nname="review"\nversion="0.0.0"\n',
    "src/app.py": "def app(): return 1\n", "build/generated.py": "def generated(): return 2\n",
    ".gitignore": ignore, "user-output/hidden.py": "def hidden(): pass\n",
    "codeatlas.config.json": '{"version":1,"excludes":["private/"]}', "private/secret.py": "def secret(): pass\n",
    ...(mixed ? { "package.json": "{}", "src/app.ts": "export const app = 1;\n", "dist/generated.js": "const generated = 1;" } : {}) });
  try {
    const policy = await resolveRepositoryExcludes(root);
    assert.ok(policy.stacks.includes("python")); if (mixed) assert.ok(policy.stacks.includes("node"));
    assert.match(policy.summary, /python /); assert.ok(policy.patterns.includes("build/"));
    assert.equal(policy.matches("build/generated.py"), true);
    const files = (await scanRepo(root)).map(f => path.relative(root, f).split(path.sep).join("/"));
    assert.ok(files.includes("src/app.py")); assert.ok(!files.some(f => /^(build|private|user-output|dist)\//.test(f)));
    const indexed = await indexRepository(root, { skipGit: true }); assert.equal(indexed.kind, "published");
    await fs.writeFile(path.join(root, "build/generated.py"), "def generated(): return 3\n");
    for (let i = 0; i < 2; i++) {
      assert.deepEqual((await scanRepo(root)).map(f => path.relative(root, f).split(path.sep).join("/")), files);
      const sync = await syncRepository(root, { skipGit: true }); assert.equal(sync.kind, "published");
      if (sync.kind === "published") { assert.equal(sync.generationReused, true); assert.deepEqual(sync.changes.addedFiles, []); assert.deepEqual(sync.changes.changedFiles, []); }
    }
    assert.equal(await fs.readFile(path.join(root, ".gitignore"), "utf8"), ignore);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("Python build rule does not exclude legitimate build source in a non-Python stack", async () => {
  const root = await fixture({ "src/app.c": "int app() { return 1; }", "build/source.c": "int source() { return 2; }" });
  try {
    const policy = await resolveRepositoryExcludes(root); assert.ok(!policy.stacks.includes("python"));
    assert.equal(policy.matches("build", true), false);
    assert.ok((await scanRepo(root)).some(f => f.endsWith(path.join("build", "source.c"))));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
