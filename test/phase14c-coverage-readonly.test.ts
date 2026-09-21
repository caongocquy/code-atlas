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

test("configured-only detection is not an authoritative negative", () => {
  const snapshot = { repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", entities: [], relationships: [], classifications: [], diagnostics: [], coverage: [], config: [], detections: [{ framework: "next" as const, scope: "root", configured: true, observed: false, capabilities: [], refs: [], complete: true }], dependencies: [], complete: true };
  const status = summarizeFrameworkCoverage(snapshot, "1.0.0");
  assert.equal(status.status, "ready");
  assert.equal(status.mayBeIncomplete, true);
  assert.equal(status.authoritativeNegativeResults, false);
});

test("applicable but unresolved coverage is not authoritative", () => {
  const snapshot = { repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", entities: [], relationships: [], classifications: [], diagnostics: [], coverage: [{ framework: "next" as const, capability: "next.routes", relativePath: "app/page.tsx", strategy: "route", outputKind: "relationship" as const, kind: "route_binding" as const, applicable: 1, supported: 1, attempted: 1, resolved: 0, ambiguous: 0, unknown: 0, unsupported: 0, budgetExhausted: 0, weakDropped: 0 }], config: [], detections: [], dependencies: [], complete: true };
  const status = summarizeFrameworkCoverage(snapshot, "1.0.0");
  assert.equal(status.mayBeIncomplete, true);
  assert.equal(status.authoritativeNegativeResults, false);
});

test("observed framework without applicable coverage is not authoritative", () => {
  const snapshot = { repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", entities: [], relationships: [], classifications: [], diagnostics: [], coverage: [], config: [], detections: [{ framework: "next" as const, scope: "root", configured: false, observed: true, capabilities: ["next.routes"], refs: [], complete: true }], dependencies: [], complete: true };
  const status = summarizeFrameworkCoverage(snapshot, "1.0.0");
  assert.equal(status.mayBeIncomplete, true);
  assert.equal(status.authoritativeNegativeResults, false);
});

test("observed capability without matching coverage is not authoritative", () => {
  const snapshot = { repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", entities: [], relationships: [], classifications: [], diagnostics: [], coverage: [{ framework: "next" as const, capability: "next.pages_routes", relativePath: "pages/index.tsx", strategy: "route", outputKind: "relationship" as const, kind: "route_binding" as const, applicable: 1, supported: 1, attempted: 1, resolved: 1, ambiguous: 0, unknown: 0, unsupported: 0, budgetExhausted: 0, weakDropped: 0 }], config: [], detections: [{ framework: "next" as const, scope: "root", configured: false, observed: true, capabilities: ["next.app_routes"], refs: [], complete: true }], dependencies: [], complete: true };
  const status = summarizeFrameworkCoverage(snapshot, "1.0.0");
  assert.equal(status.mayBeIncomplete, true);
  assert.equal(status.authoritativeNegativeResults, false);
});
