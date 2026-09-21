import assert from "node:assert/strict";
import test from "node:test";

import { reactNextAdapter } from "../src/core/framework/adapters/react-next.js";
import { resolveFrameworkEvidence } from "../src/core/framework/framework-registry.js";

test("materializes a Next app route entity and relationship", () => {
  const context = { repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["app/users/page.tsx"]), maxObservations: 10, config: [], graph: { nodes: [{ id: "file", type: "file", name: "page.tsx", file: "app/users/page.tsx" }], edges: [] }, facts: [{ relativePath: "app/users/page.tsx", facts: { frameworkSyntax: { complete: true, nodes: [] } } as never }] } as never;
  const result = reactNextAdapter.analyze(context);
  const materialized = resolveFrameworkEvidence(context, result.evidence);
  assert.equal(materialized.entities[0]?.displayName, "/users");
  assert.equal(materialized.relationships[0]?.relationKind, "route_binding");
});

test("keeps route-group layouts distinct in their semantic identity", () => {
  const context = { repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["app/(marketing)/layout.tsx", "app/(shop)/layout.tsx"]), maxObservations: 10, config: [], graph: { nodes: [{ id: "marketing", type: "file", name: "marketing", file: "app/(marketing)/layout.tsx" }, { id: "shop", type: "file", name: "shop", file: "app/(shop)/layout.tsx" }], edges: [] }, facts: [{ relativePath: "app/(marketing)/layout.tsx", facts: { frameworkSyntax: { complete: true, nodes: [] } } as never }, { relativePath: "app/(shop)/layout.tsx", facts: { frameworkSyntax: { complete: true, nodes: [] } } as never }] } as never;
  const result = resolveFrameworkEvidence(context, reactNextAdapter.analyze(context).evidence);
  assert.equal(result.entities.length, 2);
  assert.notEqual(result.entities[0]?.ref.logicalKey, result.entities[1]?.ref.logicalKey);
});
