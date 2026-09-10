import assert from "node:assert/strict";
import test from "node:test";

import { reactNextAdapter } from "../src/core/framework/adapters/react-next.js";
import { resolveFrameworkEvidence } from "../src/core/framework/framework-registry.js";

test("materializes use client as a classification without a fake target", () => {
  const context = { repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["app/page.tsx"]), maxObservations: 10, config: [], graph: { nodes: [{ id: "page", type: "function", name: "Page", file: "app/page.tsx", startLine: 1, endLine: 3 }], edges: [] }, facts: [{ relativePath: "app/page.tsx", facts: { frameworkSyntax: { complete: true, nodes: [{ id: "directive:1", kind: "directive", name: "use client", range: { startLine: 1, endLine: 1 }, children: [], arguments: [], typeArguments: [] }] } } as never }] } as never;
  const result = reactNextAdapter.analyze(context);
  const materialized = resolveFrameworkEvidence(context, result.evidence);
  assert.equal(materialized.classifications[0]?.classificationValue, "client");
  assert.equal(materialized.relationships.some((item) => item.source.kind === "language" && item.target.kind === "language" && item.source.nodeId === item.target.nodeId), false);
});
