import assert from "node:assert/strict";
import test from "node:test";
import { projectFrameworkGraph, queryFrameworkProjection } from "../src/core/graph/query/framework-query.service.js";

test("projects absent framework state as incomplete and classification-free", () => {
  const projection = projectFrameworkGraph({ nodes: [], edges: [] }, undefined);
  assert.equal(projection.mayBeIncomplete, true);
  assert.deepEqual(projection.classifications, []);
  assert.deepEqual(projection.edges, []);
});

test("keeps unary classifications separate from relationship edges", () => {
  const projection = projectFrameworkGraph({ nodes: [{ id: "page", type: "function", name: "Page", file: "page.tsx" }], edges: [] }, { repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", entities: [], relationships: [], classifications: [{ outputKind: "classification", subject: { kind: "language", nodeId: "page" }, classificationKind: "execution_boundary", classificationValue: "client", provenance: { origin: "framework_inferred", framework: "next", adapterId: "react-next", adapterVersion: "1.0.0", strategy: "directive", confidence: "exact", evidenceIds: ["e"], refs: [] } }], diagnostics: [], coverage: [], config: [], detections: [], dependencies: [], complete: true });
  assert.equal(projection.edges.length, 0);
  const queried = queryFrameworkProjection(projection, { kind: "language", nodeId: "page" }, 0);
  assert.equal(queried.nodes.length, 1);
  assert.equal(queried.classifications.length, 1);
});

test("projects incomplete framework materialization as uncertain", () => {
  const projection = projectFrameworkGraph({ nodes: [], edges: [] }, { repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", entities: [], relationships: [], classifications: [], diagnostics: [], coverage: [{ framework: "next", capability: "next.routes", relativePath: "app/page.tsx", strategy: "route", outputKind: "relationship", kind: "route_binding", applicable: 1, supported: 1, attempted: 1, resolved: 0, ambiguous: 0, unknown: 1, unsupported: 0, budgetExhausted: 0, weakDropped: 0 }], config: [], detections: [], dependencies: [], complete: false });
  assert.equal(projection.mayBeIncomplete, true);
});

test("projects observed framework without applicable coverage as uncertain", () => {
  const projection = projectFrameworkGraph({ nodes: [], edges: [] }, { repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", entities: [], relationships: [], classifications: [], diagnostics: [], coverage: [], config: [], detections: [{ framework: "next", scope: "root", configured: false, observed: true, capabilities: ["next.routes"], refs: [], complete: true }], dependencies: [], complete: true });
  assert.equal(projection.mayBeIncomplete, true);
});

test("projects a stale framework version as uncertain", () => {
  const snapshot = { repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", entities: [], relationships: [], classifications: [], diagnostics: [], coverage: [], config: [], detections: [], dependencies: [], complete: true };
  assert.equal(projectFrameworkGraph({ nodes: [], edges: [] }, snapshot, "2.0.0").mayBeIncomplete, true);
});
