import assert from "node:assert/strict";
import test from "node:test";

import { nestjsAdapter } from "../src/core/framework/adapters/nestjs.js";
import { resolveFrameworkEvidence } from "../src/core/framework/framework-registry.js";

test("resolves a uniquely typed Nest constructor provider", () => {
  const context = {
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["app.ts"]), maxObservations: 20, config: [],
    graph: { nodes: [
      { id: "service", type: "class", name: "Service", file: "app.ts", startLine: 1, endLine: 5 },
      { id: "repo", type: "class", name: "Repo", file: "app.ts", startLine: 7, endLine: 7 },
    ], edges: [] },
    facts: [{ relativePath: "app.ts", facts: {
      imports: [{ moduleSpecifier: "@nestjs/common" }],
      parameters: [{ localId: "param", ownerSymbolId: "service", name: "repo", typeText: "Repo", index: 0, range: { startLine: 2, endLine: 2 } }],
      frameworkSyntax: { complete: true, nodes: [] },
    } as never }],
  } as never;
  const result = nestjsAdapter.analyze(context);
  const materialized = resolveFrameworkEvidence(context, result.evidence);
  assert.equal(materialized.relationships.length, 1);
  assert.equal(materialized.relationships[0]?.relationKind, "dependency_injection");
  assert.equal(materialized.relationships[0]?.provenance.confidence, "exact");
});

test("drops ambiguous constructor providers", () => {
  const context = {
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["app.ts"]), maxObservations: 20, config: [],
    graph: { nodes: [{ id: "service", type: "class", name: "Service", file: "app.ts", startLine: 1, endLine: 5 }, { id: "repo1", type: "class", name: "Repo", file: "app.ts" }, { id: "repo2", type: "class", name: "Repo", file: "app.ts" }], edges: [] },
    facts: [{ relativePath: "app.ts", facts: { imports: [{ moduleSpecifier: "@nestjs/common" }], parameters: [{ localId: "param", ownerSymbolId: "service", name: "repo", typeText: "Repo", index: 0, range: { startLine: 2, endLine: 2 } }], frameworkSyntax: { complete: true, nodes: [] } } as never }],
  } as never;
  const result = nestjsAdapter.analyze(context);
  const materialized = resolveFrameworkEvidence(context, result.evidence);
  assert.equal(materialized.relationships.length, 0);
  assert.equal(materialized.diagnostics.some((item) => item.outcome === "ambiguous"), true);
});
