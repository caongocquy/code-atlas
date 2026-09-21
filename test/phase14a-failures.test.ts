import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { decodeFacts } from "../src/core/facts/facts-codec.js";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import type { ParserIdentity } from "../src/core/facts/facts.types.js";
import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

test("malformed source publishes reusable deterministic partial facts", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-partial-"));

  try {
    await writeFile(path.join(repoPath, "broken.ts"), "export function broken( {\n");
    const first = await indexRepository(repoPath, { skipGit: true });
    assert.equal(first.kind, "published");

    const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
    const manifest = store.getGenerationManifest(repository.id);
    assert.ok(manifest);
    const binding = manifest.files.find((file) => file.relativePath === "broken.ts");
    assert.ok(binding);
    const payload = store.getFactBlob(binding.factBlobKey);
    assert.ok(payload);
    const raw = JSON.parse(payload) as { parserIdentity: ParserIdentity; factsVersion: string; factsSchemaVersion: string };
    const facts = decodeFacts(payload, {
      key: binding.factBlobKey,
      contentHash: binding.contentHash,
      language: binding.language,
      parserIdentity: raw.parserIdentity,
      factsVersion: raw.factsVersion,
      factsSchemaVersion: raw.factsSchemaVersion,
    });
    assert.equal(facts.kind, "hit");
    assert.equal(facts.facts.parseStatus, "deterministic_partial");
    assert.notEqual(facts.facts.parserDiagnostics.length, 0);
    store.close();

    const second = await syncRepository(repoPath, { skipGit: true });
    assert.equal(second.kind, "published");
    assert.deepEqual(second.plan.parsePaths, []);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("unsupported parser selection is an infrastructure failure", () => {
  const result = extractParsedFacts({
    source: "const value = 1;",
    language: "unsupported" as never,
    contentHash: "hash",
    factsVersion: "1",
    factsSchemaVersion: "1",
  });
  assert.equal(result.kind, "infrastructure_failure");
});

test("cache write failure leaves the active generation unchanged", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-cache-write-failure-"));
  const originalPutFactBlob = AtlasStore.prototype.putFactBlob;

  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");
    const first = await indexRepository(repoPath, { skipGit: true });
    assert.equal(first.kind, "published");

    const before = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    const repository = before.ensureRepository(getRepositoryIdentity(repoPath));
    const activeBefore = before.getActiveGenerationId(repository.id);
    before.close();
    await writeFile(path.join(repoPath, "source.ts"), "export function source() { return false; }\n");
    AtlasStore.prototype.putFactBlob = function putFactBlobFailure(): never {
      throw new Error("injected cache write failure");
    };

    const failed = await syncRepository(repoPath, { skipGit: true });
    assert.equal(failed.kind, "failed");
    assert.equal(failed.failure.kind, "cache_write_failure");
    assert.equal(failed.failure.activeGenerationId, activeBefore);

    const after = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    try {
      assert.equal(after.getActiveGenerationId(repository.id), activeBefore);
    } finally {
      after.close();
    }
  } finally {
    AtlasStore.prototype.putFactBlob = originalPutFactBlob;
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("corrupt cache is repaired by the next mutating index", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-cache-repair-pipeline-"));
  const databasePath = path.join(repoPath, ".codeatlas", "atlas.db");

  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");
    const first = await indexRepository(repoPath, { skipGit: true });
    assert.equal(first.kind, "published");

    const store = new AtlasStore(databasePath);
    const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
    const binding = store.getGenerationManifest(repository.id)?.files[0];
    assert.ok(binding);
    store.close();
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE fact_blobs SET payload_json = ? WHERE fact_blob_key = ?").run("{", binding.factBlobKey);
    database.close();

    const repaired = await syncRepository(repoPath, { skipGit: true });
    assert.equal(repaired.kind, "published");
    const checked = new AtlasStore(databasePath);
    try {
      assert.ok(checked.getFactBlob(binding.factBlobKey));
    } finally {
      checked.close();
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
