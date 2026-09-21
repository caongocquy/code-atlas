import assert from "node:assert/strict";
import test from "node:test";

import { nestjsAdapter } from "../src/core/framework/adapters/nestjs.js";
import { resolveFrameworkEvidence } from "../src/core/framework/framework-registry.js";

test("recovers explicit Nest module provider ownership", () => {
  const context = {
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["app.ts"]), maxObservations: 20, config: [],
    graph: { nodes: [
      { id: "module", type: "class", name: "AppModule", file: "app.ts", startLine: 1, endLine: 8 },
      { id: "service", type: "class", name: "Service", file: "app.ts", startLine: 3, endLine: 3 },
    ], edges: [] },
    facts: [{ relativePath: "app.ts", facts: {
      imports: [{ moduleSpecifier: "@nestjs/common" }],
      frameworkSyntax: { complete: true, nodes: [
        { id: "module-annotation", kind: "annotation", name: "Module", ownerSymbolId: "module", range: { startLine: 1, endLine: 2 }, children: ["module-object"], arguments: [], typeArguments: [] },
        { id: "module-object", kind: "object", range: { startLine: 1, endLine: 2 }, children: ["providers"], arguments: [], typeArguments: [] },
        { id: "providers", kind: "property", name: "providers", range: { startLine: 1, endLine: 2 }, children: ["service-name"], arguments: [], typeArguments: [] },
        { id: "service-name", kind: "identifier", name: "Service", range: { startLine: 3, endLine: 3 }, children: [], arguments: [], typeArguments: [] },
      ] },
    } as never }],
  } as never;
  const result = nestjsAdapter.analyze(context);
  const materialized = resolveFrameworkEvidence(context, result.evidence);
  assert.equal(materialized.relationships.length, 1);
  assert.equal(materialized.relationships[0]?.relationKind, "module_provider");
  assert.equal(materialized.relationships[0]?.provenance.confidence, "exact");
});
