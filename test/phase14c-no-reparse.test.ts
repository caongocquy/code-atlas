import assert from "node:assert/strict";
import test from "node:test";
import { planFrameworkInvalidation } from "../src/core/framework/framework-invalidation.js";

test("framework-only version changes have no language parse/resolve requirement", () => {
  const plan = planFrameworkInvalidation({ paths: [], allPaths: ["plain.ts"], changedInputKeys: new Set(), changedLookupKeys: new Set(), previous: { repositoryId: "repo", generationId: "g", frameworkResolutionVersion: "1.0.0", entities: [], relationships: [], classifications: [], diagnostics: [], coverage: [], config: [], detections: [], dependencies: [], complete: true }, frameworkResolutionVersion: "2.0.0", topologyComplete: true });
  assert.deepEqual(plan.analyzePaths, ["plain.ts"]);
  assert.deepEqual(plan.reusePaths, []);
  assert.equal(plan.reasons.includes("framework_resolution_version_changed"), true);
});
