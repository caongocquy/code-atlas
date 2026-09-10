import assert from "node:assert/strict";
import test from "node:test";

import type { FileFactBinding, IndexVersionDomains } from "../src/core/facts/facts.types.js";
import {
  CURRENT_INDEX_VERSION_DOMAINS,
  FACTS_SCHEMA_VERSION,
  FACTS_VERSION,
  FRAMEWORK_RESOLUTION_VERSION,
} from "../src/core/repository/index-version.js";
import { planInvalidation } from "../src/core/indexing/invalidation-planner.js";

const file = "src/app.ts";
const currentFiles = new Map([[file, { contentHash: "app-1", language: "typescript" as const }]]);
const previousBindings = new Map<string, FileFactBinding>([[file, {
  repositoryId: "repo",
  relativePath: file,
  generationId: "generation-1",
  factBlobKey: "blob-app-1" as FileFactBinding["factBlobKey"],
  contentHash: "app-1",
  language: "typescript",
}]]);

function planFor(
  versions: IndexVersionDomains,
  previousVersions: IndexVersionDomains | undefined = CURRENT_INDEX_VERSION_DOMAINS,
) {
  return planInvalidation({
    repositoryFiles: [file],
    currentFiles,
    previousBindings,
    directImporters: new Map(),
    versions,
    previousVersions,
  });
}

test("owns one independent framework resolution version domain", () => {
  assert.equal(FRAMEWORK_RESOLUTION_VERSION, "1.0.0");
  assert.equal(CURRENT_INDEX_VERSION_DOMAINS.frameworkResolutionVersion, FRAMEWORK_RESOLUTION_VERSION);
  assert.deepEqual(Object.keys(CURRENT_INDEX_VERSION_DOMAINS).sort(), [
    "derivedVersion",
    "factsSchemaVersion",
    "factsVersion",
    "frameworkResolutionVersion",
    "resolutionVersion",
    "schemaVersion",
  ]);
});

test("framework-only version changes rebuild framework inputs without language work", () => {
  const plan = planFor({
    ...CURRENT_INDEX_VERSION_DOMAINS,
    frameworkResolutionVersion: "1.0.1",
  });

  assert.deepEqual(plan.parsePaths, []);
  assert.deepEqual(plan.resolvePaths, []);
  assert.deepEqual(plan.reusePaths, [file]);
  assert.equal(plan.fullGraphResolution, false);
});

test("missing legacy framework version stays stale without invalidating language work", () => {
  const legacyVersions = { ...CURRENT_INDEX_VERSION_DOMAINS };
  delete legacyVersions.frameworkResolutionVersion;

  const plan = planFor(CURRENT_INDEX_VERSION_DOMAINS, legacyVersions);

  assert.deepEqual(plan.parsePaths, []);
  assert.deepEqual(plan.resolvePaths, []);
  assert.equal(plan.fullGraphResolution, false);
});

test("facts schema and facts version changes invalidate parsed facts", () => {
  const factsSchema = planFor(
    CURRENT_INDEX_VERSION_DOMAINS,
    { ...CURRENT_INDEX_VERSION_DOMAINS, factsSchemaVersion: "2.0.0" },
  );
  assert.deepEqual(factsSchema.parsePaths, [file]);
  assert.deepEqual(factsSchema.resolvePaths, [file]);

  const facts = planFor(
    CURRENT_INDEX_VERSION_DOMAINS,
    { ...CURRENT_INDEX_VERSION_DOMAINS, factsVersion: "2.0.0" },
  );
  assert.deepEqual(facts.parsePaths, [file]);
  assert.deepEqual(facts.resolvePaths, [file]);
  assert.equal(FACTS_SCHEMA_VERSION, CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion);
  assert.equal(FACTS_VERSION, CURRENT_INDEX_VERSION_DOMAINS.factsVersion);
});

test("persistence schema changes do not invalidate compatible parsed facts", () => {
  const plan = planFor(
    CURRENT_INDEX_VERSION_DOMAINS,
    { ...CURRENT_INDEX_VERSION_DOMAINS, schemaVersion: "0.9.0" },
  );

  assert.deepEqual(plan.parsePaths, []);
  assert.deepEqual(plan.resolvePaths, []);
  assert.deepEqual(plan.reusePaths, [file]);
});

test("language resolution version changes preserve facts and resolve the graph", () => {
  const plan = planFor({
    ...CURRENT_INDEX_VERSION_DOMAINS,
    resolutionVersion: "1.0.1",
  });

  assert.deepEqual(plan.parsePaths, []);
  assert.deepEqual(plan.reusePaths, [file]);
  assert.deepEqual(plan.resolvePaths, [file]);
  assert.equal(plan.fullGraphResolution, true);
});
