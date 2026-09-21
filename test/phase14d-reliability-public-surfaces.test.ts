import assert from "node:assert/strict";
import test from "node:test";

import { projectFrameworkGraphWithReliability } from "../src/core/graph/query/framework-query.service.js";
import { summarizeFrameworkCoverage } from "../src/core/framework/framework-coverage.js";
import { canonicalReliabilityScope } from "../src/core/reliability/reliability-identity.js";
import type { FrameworkSnapshot } from "../src/core/framework/framework.types.js";
import type { ReliabilityContribution } from "../src/core/reliability/reliability.types.js";

const snapshot: FrameworkSnapshot = {
  repositoryId: "repo",
  generationId: "generation",
  frameworkResolutionVersion: "1.0.0",
  entities: [],
  relationships: [],
  classifications: [],
  diagnostics: [],
  coverage: [],
  config: [],
  detections: [],
  dependencies: [],
  complete: true,
};

const scope = canonicalReliabilityScope({ capability: "framework_repository" });

const contribution: ReliabilityContribution = {
  ownerKey: "src/routes.ts",
  scope,
  outputKey: "relationship:route",
  outcome: "accepted",
  complete: true,
  stale: false,
  origin: "framework_inferred",
  evidence: [{ origin: "framework_inferred", sourcePath: "src/routes.ts", inputKey: "route", ownerKey: "src/routes.ts" }],
  diagnostics: [],
  coverage: { applicable: true, supported: true, attempted: true, resolved: true, ambiguous: false, unknown: false, unsupported: false, budgetExhausted: false },
};

test("query and status expose the same accepted reliability projection", () => {
  const projection = projectFrameworkGraphWithReliability({ nodes: [], edges: [] }, snapshot, [contribution], scope, "1.0.0");
  const status = summarizeFrameworkCoverage(snapshot, "1.0.0", [contribution], scope);
  assert.deepEqual(projection.reliability, status.reliability);
  assert.equal(projection.reliability?.authoritativeNegative, true);
});

test("incomplete reliability is visible and never authoritative negative", () => {
  const incomplete = { ...contribution, outcome: "unknown" as const, complete: false, diagnostics: [{ code: "framework_target_unknown", outcome: "unknown" as const, ownerKey: contribution.ownerKey, evidenceIds: [] }], coverage: { ...contribution.coverage, resolved: false, unknown: true } };
  const status = summarizeFrameworkCoverage(snapshot, "1.0.0", [incomplete], scope);
  assert.equal(status.reliability?.outcome, "unknown");
  assert.equal(status.reliability?.complete, false);
  assert.equal(status.reliability?.authoritativeNegative, false);
  assert.deepEqual(status.reliability?.diagnosticCodes, ["framework_target_unknown"]);
});

test("symbol-only framework projection remains unchanged without reliability inputs", () => {
  const projection = projectFrameworkGraphWithReliability({ nodes: [], edges: [] }, snapshot, [], { capability: "framework_repository" }, "1.0.0");
  assert.equal(projection.reliability, undefined);
  assert.equal(projection.mayBeIncomplete, false);
});
