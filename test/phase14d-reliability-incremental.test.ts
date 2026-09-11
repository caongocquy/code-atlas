import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCandidateGeneration } from "../src/core/indexing/index-manifest.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import type { ReliabilityContribution } from "../src/core/reliability/reliability.types.js";
import { materializeReliabilityIncremental } from "../src/core/reliability/reliability-incremental.js";

const contribution: ReliabilityContribution = {
  ownerKey: "[\"src/routes.ts\",\"facts\",null,null]",
  scope: {
    scopeKey: "[\"route_binding\",\"relationship\",\"next\",null,null]",
    capability: "route_binding",
    outputKind: "relationship",
    framework: "next",
  },
  outputKey: "[\"relationship\",\"language:route\",\"framework:next:/users\",\"route_binding\"]",
  outcome: "accepted",
  complete: true,
  stale: false,
  origin: "framework_inferred",
  evidence: [{ origin: "framework_inferred", sourcePath: "src/routes.ts", inputKey: "route:/users", ownerKey: "[\"src/routes.ts\",\"facts\",null,null]" }],
  diagnostics: [],
  coverage: { applicable: true, supported: true, attempted: true, resolved: true, ambiguous: false, unknown: false, unsupported: false, budgetExhausted: false },
};

test("reliability contributions are generation-scoped and inactive before publication", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codeatlas-phase14d-"));
  const databasePath = path.join(root, ".codeatlas", "atlas.db");
  const store = new AtlasStore(databasePath);
  const repository = store.ensureRepository(getRepositoryIdentity(root));
  const generation = createCandidateGeneration(repository.id, undefined, {
    ...CURRENT_INDEX_VERSION_DOMAINS,
    reliabilityVersion: "1.0.0",
  }, []);

  store.beginCandidateGeneration(generation);
  store.writeCandidateManifest(generation.manifest);
  store.stageReliabilityContributions(generation.id, [contribution]);

  assert.deepEqual(store.loadReliabilityContributions(repository.id), []);
  assert.deepEqual(store.loadReliabilityContributions(repository.id, generation.id), [contribution]);
  store.close();
});

test("conflicting contribution keys are rejected atomically", () => {
  const root = mkdtempSync(path.join(tmpdir(), "codeatlas-phase14d-"));
  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
  const repository = store.ensureRepository(getRepositoryIdentity(root));
  const generation = createCandidateGeneration(repository.id, undefined, { ...CURRENT_INDEX_VERSION_DOMAINS, reliabilityVersion: "1.0.0" }, []);
  store.beginCandidateGeneration(generation);
  store.writeCandidateManifest(generation.manifest);

  const conflicting = { ...contribution, outcome: "ambiguous" as const };
  assert.throws(() => store.stageReliabilityContributions(generation.id, [contribution, conflicting]), /conflicting|duplicate/i);
  assert.deepEqual(store.loadReliabilityContributions(repository.id, generation.id), []);
  store.close();
});

function ownedContribution(owner: string, outputKey: string, overrides: Partial<ReliabilityContribution> = {}): ReliabilityContribution {
  return {
    ...contribution,
    ownerKey: owner,
    outputKey,
    evidence: [{ ...contribution.evidence[0]!, ownerKey: owner, sourcePath: owner }],
    ...overrides,
  };
}

test("incremental materialization reuses unaffected owners and removes changed owners", () => {
  const previous = [ownedContribution("src/a.ts", "output-a"), ownedContribution("src/b.ts", "output-b")];
  const next = materializeReliabilityIncremental(previous, {
    allMaterializedPaths: ["src/a.ts", "src/b.ts"],
    analysisPaths: ["src/a.ts"],
    deletedPaths: [],
    dependencyAffectedPaths: [],
  }, [ownedContribution("src/a.ts", "output-a-new")]);
  assert.deepEqual(next.map((item) => item.outputKey), ["output-a-new", "output-b"]);
});

test("multi-source output survives one contributor removal", () => {
  const previous = [ownedContribution("src/a.ts", "shared"), ownedContribution("src/b.ts", "shared")];
  const next = materializeReliabilityIncremental(previous, {
    allMaterializedPaths: ["src/a.ts", "src/b.ts"],
    analysisPaths: ["src/a.ts"],
    deletedPaths: [],
    dependencyAffectedPaths: [],
  }, []);
  assert.deepEqual(next.map((item) => item.ownerKey), ["src/b.ts"]);
});

test("deletion, dependency expansion, and version bumps widen ownership safely", () => {
  const previous = [ownedContribution("src/a.ts", "a"), ownedContribution("src/b.ts", "b")];
  const deleted = materializeReliabilityIncremental(previous, {
    allMaterializedPaths: ["src/b.ts"],
    analysisPaths: [],
    deletedPaths: ["src/a.ts"],
    dependencyAffectedPaths: [],
  }, []);
  assert.deepEqual(deleted.map((item) => item.ownerKey), ["src/b.ts"]);
  const expanded = materializeReliabilityIncremental(previous, {
    allMaterializedPaths: ["src/a.ts", "src/b.ts"],
    analysisPaths: ["src/a.ts"],
    deletedPaths: [],
    dependencyAffectedPaths: ["src/b.ts"],
  }, [ownedContribution("src/a.ts", "a"), ownedContribution("src/b.ts", "b-new")]);
  assert.deepEqual(expanded.map((item) => item.outputKey), ["a", "b-new"]);
});
