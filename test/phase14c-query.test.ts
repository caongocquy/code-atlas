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
  assert.equal(queryFrameworkProjection(projection, { kind: "language", nodeId: "page" }, 0).classifications.length, 1);
});
