import assert from "node:assert/strict";
import test from "node:test";
import { summarizeFrameworkCoverage } from "../src/core/framework/framework-coverage.js";

test("missing framework state is explicitly incomplete", () => {
  const status = summarizeFrameworkCoverage(undefined, "1.0.0");
  assert.equal(status.status, "not_indexed");
  assert.equal(status.mayBeIncomplete, true);
  assert.equal(status.authoritativeNegativeResults, false);
});

test("version mismatch and incomplete observations are not authoritative negatives", () => {
  const snapshot = { repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "0.9.0", entities: [], relationships: [], classifications: [], diagnostics: [], coverage: [], config: [{ relativePath: "package.json", scope: "root", inputKey: "package", kind: "package" as const, values: {}, complete: false }], detections: [], dependencies: [], complete: true };
  const status = summarizeFrameworkCoverage(snapshot, "1.0.0");
  assert.equal(status.status, "stale");
  assert.equal(status.authoritativeNegativeResults, false);
});
