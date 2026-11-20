import assert from "node:assert/strict";
import test from "node:test";

import type { FileFactBinding, IndexVersionDomains } from "../src/core/facts/facts.types.js";
import { planInvalidation } from "../src/core/indexing/invalidation-planner.js";

const versions: IndexVersionDomains = {
  schemaVersion: "schema-1",
  factsSchemaVersion: "facts-schema-1",
  factsVersion: "facts-1",
  resolutionVersion: "resolution-1",
  derivedVersion: "derived-1",
};

function binding(relativePath: string, hash: string): FileFactBinding {
  return {
    repositoryId: "repo",
    relativePath,
    generationId: "previous",
    factBlobKey: `blob-${hash}` as FileFactBinding["factBlobKey"],
    contentHash: hash,
    language: "typescript",
  };
}

test("CA-01 unrelated external imports do not widen bounded source invalidation", () => {
  const result = planInvalidation({
    repositoryFiles: ["consumer.ts", "dependency.ts", "external.ts"],
    currentFiles: new Map([
      ["consumer.ts", { contentHash: "consumer-1", language: "typescript" }],
      ["dependency.ts", { contentHash: "dependency-2", language: "typescript" }],
      ["external.ts", { contentHash: "external-1", language: "typescript" }],
    ]),
    previousBindings: new Map([
      ["consumer.ts", binding("consumer.ts", "consumer-1")],
      ["dependency.ts", binding("dependency.ts", "dependency-1")],
      ["external.ts", binding("external.ts", "external-1")],
    ]),
    directImporters: new Map([
      ["dependency.ts", new Set(["consumer.ts"])],
      ["module:node:path", new Set(["external.ts"])],
    ]),
    versions,
    previousVersions: versions,
  });

  assert.deepEqual(result.importersInvalidated, ["consumer.ts"]);
  assert.deepEqual(result.resolvePaths, ["consumer.ts", "dependency.ts"]);
  assert.equal(result.dependencyImpact, "bounded");
  assert.equal(result.fullGraphResolution, false);
  assert.equal(result.reasons.includes("unresolved_import_ownership"), false);
});
