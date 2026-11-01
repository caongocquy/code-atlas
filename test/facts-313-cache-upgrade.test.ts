import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { factBlobKey } from "../src/core/facts/facts-identity.js";
import { decodeFacts } from "../src/core/facts/facts-codec.js";
import type { FactBlobKey, ParsedFactsBlob } from "../src/core/facts/facts.types.js";
import { decodeFrameworkGraphqlOperationIdentity } from "../src/core/framework/framework-identity.js";
import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import type { IndexRunOutcome, PublishedIndexRun } from "../src/core/indexing/indexing.types.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

const oldVersion = "3.1.2";
const newVersion = "3.1.3";
const sources = {
  "resolver.ts": 'import { Resolver, Subscription } from "@nestjs/graphql";\n@Resolver() export class R { @Subscription("changed") updates() {} }\n',
  "helper.ts": "export const unchanged = true;\n",
};
const loader = pathToFileURL(createRequire(import.meta.url).resolve("tsx/esm")).href;

function snapshot(repoPath: string, repositoryId: string) {
  const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"), { readOnly: true });
  try {
    const manifest = store.getGenerationManifest(repositoryId);
    assert.ok(manifest);
    const binding = manifest.files.find((file) => file.relativePath === "resolver.ts");
    assert.ok(binding);
    const payload = store.getFactBlob(binding.factBlobKey);
    assert.ok(payload);
    const facts = JSON.parse(payload) as ParsedFactsBlob;
    const decoded = decodeFacts(payload, { key: binding.factBlobKey, contentHash: binding.contentHash,
      language: binding.language, parserIdentity: facts.parserIdentity,
      factsVersion: facts.factsVersion, factsSchemaVersion: facts.factsSchemaVersion });
    assert.equal(decoded.kind, "hit");
    const framework = store.loadFramework(repositoryId);
    assert.ok(framework);
    return { manifest, binding, facts, framework };
  } finally { store.close(); }
}

function ownerName(facts: ParsedFactsBlob): string | undefined {
  const annotation = facts.frameworkSyntax?.nodes.find((node) => node.kind === "annotation" && node.name === "Subscription");
  assert.ok(annotation);
  return facts.symbols.find((symbol) => symbol.localId === annotation.ownerSymbolId)?.name;
}

async function seedLegacy(repoPath: string): Promise<PublishedIndexRun> {
  for (const [file, source] of Object.entries(sources)) await writeFile(path.join(repoPath, file), source);
  const savedVersion = CURRENT_INDEX_VERSION_DOMAINS.factsVersion;
  const savedPut = AtlasStore.prototype.putFactBlob;
  let seeded = 0;
  CURRENT_INDEX_VERSION_DOMAINS.factsVersion = oldVersion;
  AtlasStore.prototype.putFactBlob = function (key, facts) {
    const cached = structuredClone(facts);
    const annotation = cached.frameworkSyntax?.nodes.find((node) => node.kind === "annotation" && node.name === "Subscription");
    if (annotation) {
      // Seed only the legacy cached payload; the real publication gate stays enabled.
      const owner = cached.symbols.find((symbol) => symbol.kind === "class" && symbol.name === "R");
      assert.ok(owner);
      annotation.ownerSymbolId = owner.localId;
      seeded++;
    }
    savedPut.call(this, key, cached);
  };
  try {
    const result = await indexRepository(repoPath, { skipGit: true });
    assert.equal(result.kind, "published", JSON.stringify(result));
    assert.equal(seeded, 1);
    const state = snapshot(repoPath, result.repositoryId);
    assert.equal(state.manifest.versions.factsVersion, oldVersion);
    assert.equal(ownerName(state.facts), "R");
    assert.deepEqual(state.framework.entities.map((entity) => decodeFrameworkGraphqlOperationIdentity(entity.ref)),
      [["root", "subscription", "changed"]]);
    return result;
  } finally {
    AtlasStore.prototype.putFactBlob = savedPut;
    CURRENT_INDEX_VERSION_DOMAINS.factsVersion = savedVersion;
  }
}

function restart(repoPath: string, operation: "index" | "sync", failPublication = false): IndexRunOutcome {
  const pipeline = new URL("../src/core/indexing/index-pipeline.service.ts", import.meta.url).href;
  const storage = new URL("../src/storage/atlas/atlas.store.ts", import.meta.url).href;
  const code = `
    const pipeline = await import(${JSON.stringify(pipeline)});
    const { AtlasStore } = await import(${JSON.stringify(storage)});
    if (${failPublication}) AtlasStore.prototype.publishCandidateGeneration = function () { throw new Error("injected upgrade publication failure"); };
    const result = await pipeline.${operation === "sync" ? "syncRepository" : "indexRepository"}(process.argv[1], { skipGit: true });
    console.log(JSON.stringify({ ...result, counters: result.kind === "published" ? result.counters : undefined }));
  `;
  const child = spawnSync(process.execPath, ["--import", loader, "--input-type=module", "-e", code, repoPath],
    { encoding: "utf8", timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(child.error, undefined, String(child.error));
  assert.equal(child.signal, null, child.stderr);
  assert.equal(child.status, 0, child.stderr);
  return JSON.parse(child.stdout.trim()) as IndexRunOutcome;
}

function published(result: IndexRunOutcome): PublishedIndexRun {
  assert.equal(result.kind, "published", JSON.stringify(result));
  return result;
}

async function assertUpgrade(repoPath: string, initial: PublishedIndexRun, operation: "index" | "sync") {
  const before = snapshot(repoPath, initial.repositoryId);
  const upgraded = published(restart(repoPath, operation));
  assert.equal(upgraded.counters.filesParsed, 2);
  assert.equal(upgraded.counters.factCacheMisses, 2);
  assert.equal(upgraded.counters.factCacheHits, 0);
  assert.deepEqual(upgraded.plan.parsePaths, ["helper.ts", "resolver.ts"]);
  assert.ok(upgraded.plan.reasons.includes("facts_version_changed"));
  assert.notEqual(upgraded.generationId, initial.generationId);
  const after = snapshot(repoPath, initial.repositoryId);
  assert.equal(after.manifest.versions.factsVersion, newVersion);
  assert.deepEqual({ ...after.manifest.versions, factsVersion: oldVersion }, before.manifest.versions);
  assert.equal(after.binding.contentHash, before.binding.contentHash);
  assert.notEqual(after.binding.factBlobKey, before.binding.factBlobKey);
  assert.equal(factBlobKey({ ...before.facts, factsVersion: newVersion }), after.binding.factBlobKey);
  assert.equal(ownerName(after.facts), "updates");
  assert.deepEqual(after.framework.entities.map((entity) => decodeFrameworkGraphqlOperationIdentity(entity.ref)),
    [["root", "subscription", "changed"]]);
  for (const [file, source] of Object.entries(sources)) assert.equal(await readFile(path.join(repoPath, file), "utf8"), source);
  const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"), { readOnly: true });
  try {
    assert.ok(store.getFactBlob(before.binding.factBlobKey), "old valid cache rows are retained");
    assert.deepEqual(store.loadFramework(initial.repositoryId, initial.generationId), before.framework);
  } finally { store.close(); }
  const warm = published(restart(repoPath, "sync"));
  assert.equal(warm.generationId, upgraded.generationId);
  assert.equal(warm.counters.filesParsed, 0);
  assert.equal(warm.counters.factCacheMisses, 0);
  assert.deepEqual(snapshot(repoPath, initial.repositoryId), after);
  return after;
}

for (const operation of ["index", "sync"] as const) test(`facts3.1.3 ${operation} reparses unchanged legacy ownership facts after restart`, async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-cache-upgrade-"));
  try { await assertUpgrade(root, await seedLegacy(root), operation); }
  finally { await rm(root, { recursive: true, force: true }); }
});

test("facts upgrade publication failure retains the old generation and retries using only current-version cache", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-cache-recovery-"));
  try {
    const initial = await seedLegacy(root);
    const before = snapshot(root, initial.repositoryId);
    const failed = restart(root, "sync", true);
    assert.equal(failed.kind, "failed");
    if (failed.kind !== "failed") throw new Error("expected upgrade failure");
    assert.equal(failed.published, false);
    assert.equal(failed.failure.activeGenerationId, initial.generationId);
    assert.match(failed.failure.message, /injected upgrade publication failure/);
    assert.deepEqual(snapshot(root, initial.repositoryId), before);
    const recovered = published(restart(root, "sync"));
    assert.notEqual(recovered.generationId, initial.generationId);
    assert.equal(recovered.counters.filesParsed, 0);
    assert.equal(recovered.counters.factCacheHits, 2);
    assert.equal(recovered.counters.factCacheMisses, 0);
    const after = snapshot(root, initial.repositoryId);
    assert.equal(after.manifest.versions.factsVersion, newVersion);
    assert.notEqual(after.binding.factBlobKey, before.binding.factBlobKey);
    assert.equal(ownerName(after.facts), "updates");
    assert.deepEqual(after.framework.entities.map((entity) => decodeFrameworkGraphqlOperationIdentity(entity.ref)),
      [["root", "subscription", "changed"]]);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("identical source in another repository cannot reuse stale ownership across facts versions", async () => {
  const a = await mkdtemp(path.join(tmpdir(), "code-atlas-cache-repo-a-"));
  const b = await mkdtemp(path.join(tmpdir(), "code-atlas-cache-repo-b-"));
  try {
    const first = await seedLegacy(a), second = await seedLegacy(b);
    const oldB = snapshot(b, second.repositoryId);
    const newA = await assertUpgrade(a, first, "sync");
    assert.deepEqual(snapshot(b, second.repositoryId), oldB);
    const newB = await assertUpgrade(b, second, "sync");
    assert.equal(newA.binding.factBlobKey, newB.binding.factBlobKey);
    assert.notEqual(first.repositoryId, second.repositoryId);
    assert.notEqual(newA.manifest.generationId, newB.manifest.generationId);
  } finally {
    await rm(a, { recursive: true, force: true });
    await rm(b, { recursive: true, force: true });
  }
});

test("a failed legacy extraction keeps its stale cache until a versioned upgrade publishes the corrected entity", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-cache-failed-legacy-"));
  const savedVersion = CURRENT_INDEX_VERSION_DOMAINS.factsVersion;
  const savedPut = AtlasStore.prototype.putFactBlob;
  try {
    CURRENT_INDEX_VERSION_DOMAINS.factsVersion = oldVersion;
    await writeFile(path.join(root, "helper.ts"), sources["helper.ts"]);
    await writeFile(path.join(root, "resolver.ts"), "export class R { updates() {} }\n");
    const initial = published(await indexRepository(root, { skipGit: true }));
    await writeFile(path.join(root, "resolver.ts"), sources["resolver.ts"]);
    let staleKey: FactBlobKey | undefined;
    AtlasStore.prototype.putFactBlob = function (key, facts) {
      const annotation = facts.frameworkSyntax?.nodes.find((node) => node.kind === "annotation" && node.name === "Subscription");
      if (annotation) {
        const owner = facts.symbols.find((symbol) => symbol.kind === "class" && symbol.name === "R");
        assert.ok(owner);
        annotation.ownerSymbolId = owner.localId;
        staleKey = key;
      }
      savedPut.call(this, key, facts);
    };
    const rejected = await syncRepository(root, { skipGit: true });
    assert.equal(rejected.kind, "failed");
    assert.equal(rejected.failure.activeGenerationId, initial.generationId);
    assert.match(rejected.failure.message, /Candidate framework materialization is incomplete/);
    assert.ok(staleKey);
    AtlasStore.prototype.putFactBlob = savedPut;
    const noBump = await syncRepository(root, { skipGit: true });
    assert.equal(noBump.kind, "failed", "the fixed extractor alone must not silently bypass the old valid cache");
    assert.equal(noBump.failure.activeGenerationId, initial.generationId);
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"), { readOnly: true });
    let staleFacts: ParsedFactsBlob;
    try {
      const payload = store.getFactBlob(staleKey);
      assert.ok(payload, "failed candidates can leave a valid but semantically wrong legacy blob");
      staleFacts = JSON.parse(payload) as ParsedFactsBlob;
      assert.equal(staleFacts.factsVersion, oldVersion);
      assert.equal(ownerName(staleFacts), "R");
      assert.deepEqual(store.loadFramework(initial.repositoryId)?.entities, []);
    } finally { store.close(); }
    CURRENT_INDEX_VERSION_DOMAINS.factsVersion = savedVersion;
    const upgraded = published(restart(root, "sync"));
    assert.equal(upgraded.counters.filesParsed, 2);
    assert.equal(upgraded.counters.factCacheMisses, 2);
    assert.equal(upgraded.counters.factCacheHits, 0);
    const after = snapshot(root, initial.repositoryId);
    assert.equal(after.binding.contentHash, staleFacts.contentHash);
    assert.equal(after.binding.factBlobKey, factBlobKey({ ...staleFacts, factsVersion: newVersion }));
    assert.notEqual(after.binding.factBlobKey, staleKey);
    assert.equal(ownerName(after.facts), "updates");
    assert.deepEqual(after.framework.entities.map((entity) => decodeFrameworkGraphqlOperationIdentity(entity.ref)),
      [["root", "subscription", "changed"]]);
    assert.equal(await readFile(path.join(root, "resolver.ts"), "utf8"), sources["resolver.ts"]);
  } finally {
    AtlasStore.prototype.putFactBlob = savedPut;
    CURRENT_INDEX_VERSION_DOMAINS.factsVersion = savedVersion;
    await rm(root, { recursive: true, force: true });
  }
});
