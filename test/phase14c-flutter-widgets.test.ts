import assert from "node:assert/strict";
import test from "node:test";
import { flutterAdapter } from "../src/core/framework/adapters/flutter.js";
import { resolveFrameworkEvidence } from "../src/core/framework/framework-registry.js";

test("recovers explicit Flutter widget construction", () => {
  const context = { repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["app.dart"]), maxObservations: 20, config: [], graph: { nodes: [{ id: "app", type: "class", name: "App", file: "app.dart", startLine: 1, endLine: 5 }, { id: "child", type: "class", name: "Child", file: "app.dart", startLine: 7, endLine: 7 }], edges: [] }, facts: [{ relativePath: "app.dart", facts: { imports: [{ moduleSpecifier: "package:flutter/widgets.dart" }], frameworkSyntax: { complete: true, nodes: [{ id: "child-call", kind: "construct", name: "Child", typeArguments: [], range: { startLine: 2, endLine: 2 }, children: [], arguments: [] }] } } as never }] } as never;
  const result = flutterAdapter.analyze(context);
  const materialized = resolveFrameworkEvidence(context, result.evidence);
  assert.equal(materialized.relationships[0]?.relationKind, "widget_composition");
});
