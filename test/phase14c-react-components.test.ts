import assert from "node:assert/strict";
import test from "node:test";

import { reactNextAdapter } from "../src/core/framework/adapters/react-next.js";
import { resolveFrameworkEvidence } from "../src/core/framework/framework-registry.js";
import type { FrameworkAnalysisContext } from "../src/core/framework/framework.types.js";

test("recovers explicit local JSX component usage", () => {
  const context = {
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["App.tsx"]), maxObservations: 10,
    config: [], graph: { nodes: [
      { id: "app", type: "function", name: "App", file: "App.tsx", startLine: 1, endLine: 1 },
      { id: "child", type: "function", name: "Child", file: "App.tsx", startLine: 2, endLine: 2 },
    ], edges: [] },
    facts: [{ relativePath: "App.tsx", facts: { frameworkSyntax: { complete: true, nodes: [{ id: "jsx:1", kind: "jsx", name: "Child", range: { startLine: 1, endLine: 1 }, children: [], arguments: [], typeArguments: [] }] } } as never }],
  } satisfies FrameworkAnalysisContext;
  const result = reactNextAdapter.analyze(context);
  const materialized = resolveFrameworkEvidence(context, result.evidence);
  assert.equal(result.evidence.length, 1);
  assert.equal(result.evidence[0]?.outputKind, "relationship");
  assert.equal(materialized.relationships.length, 1);
  assert.equal(materialized.relationships[0]?.relationKind, "component_usage");
});

test("ignores intrinsic DOM tags", () => {
  const result = reactNextAdapter.analyze({
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["App.tsx"]), maxObservations: 10,
    config: [], graph: { nodes: [{ id: "app", type: "function", name: "App", file: "App.tsx", startLine: 1, endLine: 1 }], edges: [] },
    facts: [{ relativePath: "App.tsx", facts: { frameworkSyntax: { complete: true, nodes: [{ id: "jsx:1", kind: "jsx", name: "div", range: { startLine: 1, endLine: 1 }, children: [], arguments: [], typeArguments: [] }] } } as never }],
  });
  assert.equal(result.evidence.length, 0);
});

test("resolves an imported JSX component only when its graph target is unique", () => {
  const context = {
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["App.tsx"]), maxObservations: 10,
    config: [], graph: { nodes: [
      { id: "app-file", type: "file", name: "App.tsx", file: "App.tsx" },
      { id: "app", type: "function", name: "App", file: "App.tsx", startLine: 1, endLine: 3 },
      { id: "button-file", type: "file", name: "components/Button.tsx", file: "components/Button.tsx" },
      { id: "button", type: "function", name: "Button", qualifiedName: "./components/Button.Button", file: "components/Button.tsx", startLine: 1, endLine: 2 },
    ], edges: [{ from: "app-file", to: "button-file", type: "imports" }, { from: "button-file", to: "button", type: "contains" }] },
    facts: [{ relativePath: "App.tsx", facts: { imports: [{ moduleSpecifier: "./components/Button", localName: "UI", importedName: "Button" }], frameworkSyntax: { complete: true, nodes: [{ id: "jsx:1", kind: "jsx", name: "UI", range: { startLine: 2, endLine: 2 }, children: [], arguments: [], typeArguments: [] }] } } } as never],
  } satisfies FrameworkAnalysisContext;
  const result = resolveFrameworkEvidence(context, reactNextAdapter.analyze(context).evidence);
  assert.equal(result.relationships[0]?.target.kind, "language");
  assert.equal(result.relationships[0]?.target.kind === "language" && result.relationships[0].target.nodeId, "button");
});
