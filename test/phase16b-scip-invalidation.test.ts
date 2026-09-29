import assert from "node:assert/strict";
import test from "node:test";

import { planInvalidation } from "../src/core/indexing/invalidation-planner.js";

test("SCIP fingerprint changes re-resolve the graph without reparsing parser facts", () => {
  const plan = planInvalidation({
    repositoryFiles: ["src/a.ts", "src/b.ts"],
    currentFiles: new Map([
      ["src/a.ts", { contentHash: "a", language: "typescript" as const }],
      ["src/b.ts", { contentHash: "b", language: "typescript" as const }],
    ]),
    previousBindings: new Map([
      ["src/a.ts", { repositoryId: "repo", relativePath: "src/a.ts", generationId: "g1", factBlobKey: "a" as never, contentHash: "a", language: "typescript" as const }],
      ["src/b.ts", { repositoryId: "repo", relativePath: "src/b.ts", generationId: "g1", factBlobKey: "b" as never, contentHash: "b", language: "typescript" as const }],
    ]),
    directImporters: new Map(),
    versions: {
      schemaVersion: "schema-1",
      factsSchemaVersion: "facts-schema-1",
      factsVersion: "facts-1",
      resolutionVersion: "resolution-1",
      derivedVersion: "derived-1",
      scipFingerprint: "scip-new",
      scipStatus: "ready",
    },
    previousVersions: {
      schemaVersion: "schema-1",
      factsSchemaVersion: "facts-schema-1",
      factsVersion: "facts-1",
      resolutionVersion: "resolution-1",
      derivedVersion: "derived-1",
      scipFingerprint: "scip-old",
      scipStatus: "ready",
    },
  });

  assert.deepEqual(plan.parsePaths, []);
  assert.deepEqual(plan.resolvePaths, ["src/a.ts", "src/b.ts"]);
  assert.equal(plan.fullGraphResolution, true);
  assert.ok(plan.reasons.includes("scip_fingerprint_changed" as never));
});

test("an unchanged failed SCIP run can retry without forcing repeated graph resolution", () => {
  const plan = planInvalidation({
    repositoryFiles: ["src/a.ts"],
    currentFiles: new Map([["src/a.ts", { contentHash: "a", language: "typescript" as const }]]),
    previousBindings: new Map([
      ["src/a.ts", { repositoryId: "repo", relativePath: "src/a.ts", generationId: "g1", factBlobKey: "a" as never, contentHash: "a", language: "typescript" as const }],
    ]),
    directImporters: new Map(),
    versions: {
      schemaVersion: "schema-1",
      factsSchemaVersion: "facts-schema-1",
      factsVersion: "facts-1",
      resolutionVersion: "resolution-1",
      derivedVersion: "derived-1",
      scipFingerprint: "same",
      scipStatus: "failed",
    },
    previousVersions: {
      schemaVersion: "schema-1",
      factsSchemaVersion: "facts-schema-1",
      factsVersion: "facts-1",
      resolutionVersion: "resolution-1",
      derivedVersion: "derived-1",
      scipFingerprint: "same",
      scipStatus: "failed",
    },
  });

  assert.deepEqual(plan.parsePaths, []);
  assert.deepEqual(plan.resolvePaths, []);
  assert.equal(plan.fullGraphResolution, false);
});

test("a failed SCIP fingerprint change keeps parser-only invalidation bounded", () => {
  const plan = planInvalidation({
    repositoryFiles: ["src/a.ts", "src/b.ts"],
    currentFiles: new Map([
      ["src/a.ts", { contentHash: "a", language: "typescript" as const }],
      ["src/b.ts", { contentHash: "b", language: "typescript" as const }],
    ]),
    previousBindings: new Map([
      ["src/a.ts", { repositoryId: "repo", relativePath: "src/a.ts", generationId: "g1", factBlobKey: "a" as never, contentHash: "a", language: "typescript" as const }],
      ["src/b.ts", { repositoryId: "repo", relativePath: "src/b.ts", generationId: "g1", factBlobKey: "b" as never, contentHash: "b", language: "typescript" as const }],
    ]),
    directImporters: new Map(),
    versions: {
      schemaVersion: "schema-1", factsSchemaVersion: "facts-schema-1", factsVersion: "facts-1",
      resolutionVersion: "resolution-1", derivedVersion: "derived-1", scipFingerprint: "scip-new", scipStatus: "failed",
    },
    previousVersions: {
      schemaVersion: "schema-1", factsSchemaVersion: "facts-schema-1", factsVersion: "facts-1",
      resolutionVersion: "resolution-1", derivedVersion: "derived-1", scipFingerprint: "scip-old", scipStatus: "failed",
    },
  });

  assert.deepEqual(plan.parsePaths, []);
  assert.deepEqual(plan.resolvePaths, []);
  assert.equal(plan.fullGraphResolution, false);
  assert.ok(!plan.reasons.includes("scip_fingerprint_changed" as never));
});

test("legacy manifests do not re-resolve merely because SCIP is unavailable", () => {
  const plan = planInvalidation({
    repositoryFiles: ["src/a.ts"],
    currentFiles: new Map([["src/a.ts", { contentHash: "a", language: "typescript" as const }]]),
    previousBindings: new Map([
      ["src/a.ts", { repositoryId: "repo", relativePath: "src/a.ts", generationId: "g1", factBlobKey: "a" as never, contentHash: "a", language: "typescript" as const }],
    ]),
    directImporters: new Map(),
    versions: {
      schemaVersion: "schema-1", factsSchemaVersion: "facts-schema-1", factsVersion: "facts-1",
      resolutionVersion: "resolution-1", derivedVersion: "derived-1", scipFingerprint: "current", scipStatus: "unavailable",
    },
    previousVersions: {
      schemaVersion: "schema-1", factsSchemaVersion: "facts-schema-1", factsVersion: "facts-1",
      resolutionVersion: "resolution-1", derivedVersion: "derived-1",
    },
  });

  assert.deepEqual(plan.parsePaths, []);
  assert.deepEqual(plan.resolvePaths, []);
  assert.equal(plan.fullGraphResolution, false);
  assert.ok(!plan.reasons.includes("scip_status_changed" as never));
});
