import assert from "node:assert/strict";
import test from "node:test";

import {
  createResolutionScope,
  planInvalidation,
  type InvalidationPlan,
} from "../src/core/indexing/invalidation-planner.js";

const allResolutionCapablePaths = ["src/consumer.ts", "src/dep.ts", "src/other.ts"];

function fixtureInput(overrides: Partial<Parameters<typeof planInvalidation>[0]> = {}) {
  return {
    repositoryFiles: allResolutionCapablePaths,
    currentFiles: new Map([
      ["src/consumer.ts", { contentHash: "consumer-1", language: "typescript" as const }],
      ["src/dep.ts", { contentHash: "dep-2", language: "typescript" as const }],
      ["src/other.ts", { contentHash: "other-1", language: "typescript" as const }],
    ]),
    previousBindings: new Map([
      ["src/consumer.ts", { contentHash: "consumer-1", language: "typescript" as const }],
      ["src/dep.ts", { contentHash: "dep-1", language: "typescript" as const }],
      ["src/other.ts", { contentHash: "other-1", language: "typescript" as const }],
    ]),
    directImporters: new Map([["src/dep.ts", new Set(["src/consumer.ts"])]]),
    versions: {
      schemaVersion: "schema-1",
      factsSchemaVersion: "facts-schema-1",
      factsVersion: "facts-1",
      resolutionVersion: "resolution-1",
      derivedVersion: "derived-1",
    },
    ...overrides,
  };
}

function planWithReason(reason: InvalidationPlan["reasons"][number]): InvalidationPlan {
  return {
    parsePaths: [],
    reusePaths: [],
    resolvePaths: allResolutionCapablePaths,
    removedPaths: [],
    derivedRebuild: false,
    fullGraphResolution: true,
    dependencyImpact: "uncertain",
    importersInvalidated: [],
    reasons: [reason],
  };
}

const repositoryCases = [
  ["resolution_version_changed", "resolution_version"],
  ["unresolved_import_ownership", "uncertain_importer"],
  ["path_moved", "module_move"],
  ["path_renamed", "module_rename"],
  ["module_config_changed", "module_config"],
  ["export_ambiguous", "export_ambiguity"],
  ["dependency_provenance_incomplete", "incomplete_provenance"],
  ["facts_version_changed", "facts_change"],
] as const;

test("resolution scope is bounded for a changed file and its direct importer", () => {
  const plan = planInvalidation(fixtureInput({
    currentFiles: new Map([
      ["src/consumer.ts", { contentHash: "consumer-1", language: "typescript" as const }],
      ["src/dep.ts", { contentHash: "dep-2", language: "typescript" as const }],
      ["src/other.ts", { contentHash: "other-1", language: "typescript" as const }],
    ]),
  }));

  assert.deepEqual(createResolutionScope(plan), {
    mode: "bounded",
    paths: ["src/consumer.ts", "src/dep.ts"],
    reasons: ["changed_source", "direct_importer"],
  });
});

test("every unsafe invalidation reason forces repository resolution", () => {
  for (const [planReason, scopeReason] of repositoryCases) {
    const scope = createResolutionScope(planWithReason(planReason));
    assert.equal(scope.mode, "repository", planReason);
    assert.ok(scope.reasons.includes(scopeReason), planReason);
    assert.deepEqual(scope.paths, allResolutionCapablePaths);
  }
});
