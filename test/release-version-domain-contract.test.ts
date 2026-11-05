import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import { factBlobKey } from "../src/core/facts/facts-identity.js";
import { decodeFacts, encodeFacts } from "../src/core/facts/facts-codec.js";
import { expectation, makeFacts } from "./helpers/phase14b-facts.js";

test("v1.7.0 owns the explicitly reviewed facts and independent version domains", () => {
  assert.equal(CURRENT_INDEX_VERSION_DOMAINS.factsVersion, "3.1.3");
  assert.equal(CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion, "3.0.0");
  assert.equal(CURRENT_INDEX_VERSION_DOMAINS.frameworkResolutionVersion, "1.7.1");
  const old = makeFacts({ factsVersion: "3.1.2", factsSchemaVersion: "3.0.0" });
  const fresh = { ...old, factsVersion: "3.1.3" };
  assert.notEqual(factBlobKey(old), factBlobKey(fresh));
  assert.equal(decodeFacts(encodeFacts(old), expectation(fresh)).kind, "miss");
  assert.deepEqual(decodeFacts(encodeFacts(old), expectation(old)), { kind: "hit", facts: old });
});

for (const domain of ["resolutionVersion", "frameworkResolutionVersion"] as const) {
  test(`${domain} upgrade retains unchanged facts bindings and independent domains`, async () => {
    const root = await mkdtemp(path.join(tmpdir(), "code-atlas-release-domain-"));
    try {
      await writeFile(path.join(root, "resolver.ts"), 'import { Resolver, Query } from "@nestjs/graphql"; @Resolver() export class R { @Query() users() { return "ok"; } }\n');
      const first = await indexRepository(root, { skipGit: true });
      assert.equal(first.kind, "published", JSON.stringify(first));
      if (first.kind !== "published") throw new Error("first publication required");
      const dbPath = path.join(root, ".codeatlas", "atlas.db");
      const store = new AtlasStore(dbPath);
      try {
        const before = store.getGenerationManifest(first.repositoryId);
        assert.ok(before);
        const db = new DatabaseSync(dbPath);
        try {
          const legacy = { ...before.versions, [domain]: domain === "resolutionVersion" ? "1.1.0" : "1.3.0" };
          db.prepare("UPDATE index_manifests SET versions_json = ? WHERE generation_id = ?").run(JSON.stringify(legacy), first.generationId);
          db.prepare("UPDATE index_generations SET versions_json = ? WHERE id = ?").run(JSON.stringify(legacy), first.generationId);
          if (domain === "frameworkResolutionVersion") {
            db.prepare("UPDATE generation_framework_state SET framework_resolution_version = ? WHERE generation_id = ?").run("1.3.0", first.generationId);
          }
        } finally { db.close(); }
        const second = await syncRepository(root, { skipGit: true });
        assert.equal(second.kind, "published", JSON.stringify(second));
        if (second.kind !== "published") throw new Error("upgrade publication required");
        assert.equal(second.counters.filesParsed, 0);
        assert.equal(second.counters.factCacheMisses, 0);
        if (domain === "resolutionVersion") {
          assert.equal(second.counters.filesResolved, 1);
          assert.ok(second.plan.reasons.includes("resolution_version_changed"));
        } else {
          assert.equal(second.counters.filesResolved, 0);
          assert.ok(second.counters.frameworkFilesResolved > 0);
        }
        const after = store.getGenerationManifest(first.repositoryId);
        assert.ok(after);
        assert.notEqual(after.generationId, before.generationId);
        assert.deepEqual(after.versions, before.versions);
        assert.deepEqual(after.files.map(file => [file.relativePath, file.contentHash, file.factBlobKey]),
          before.files.map(file => [file.relativePath, file.contentHash, file.factBlobKey]));
        const framework = store.loadFramework(first.repositoryId);
        assert.ok(framework);
        assert.equal(framework.frameworkResolutionVersion, "1.7.1");
        assert.equal(framework.entities.length, 1);
      } finally { store.close(); }
    } finally { await rm(root, { recursive: true, force: true }); }
  });
}
