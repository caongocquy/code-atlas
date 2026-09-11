import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeFlutterRoute, flutterAdapter } from "../src/core/framework/adapters/flutter.js";
import { resolveFrameworkEvidence } from "../src/core/framework/framework-registry.js";

test("canonicalizes a Flutter named route without web normalization", () => {
  const route = canonicalizeFlutterRoute({ framework: "flutter", scope: "app", router: "material:App", kind: "route", path: "/settings", method: null, conditions: [], owner: null });
  assert.equal(route.kind, "canonical");
  if (route.kind === "canonical") assert.ok(route.ref.logicalKey.includes("/settings"));
});

test("preserves repeated separators in an exact Flutter route name", () => {
  const result = canonicalizeFlutterRoute({ framework: "flutter", scope: "root", router: "material:App", kind: "route", path: "//settings", method: null, conditions: [], owner: null });
  assert.equal(result.kind, "canonical");
});

test("materializes a named route and explicit pushNamed binding", () => {
  const context = { repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["app.dart"]), maxObservations: 20, config: [], graph: { nodes: [{ id: "app", type: "class", name: "App", file: "app.dart", startLine: 1, endLine: 8 }, { id: "nav", type: "method", name: "open", file: "app.dart", startLine: 2, endLine: 4 }], edges: [] }, facts: [{ relativePath: "app.dart", facts: { imports: [{ moduleSpecifier: "package:flutter/material.dart" }], frameworkSyntax: { complete: true, nodes: [{ id: "route", kind: "property", name: "/settings", range: { startLine: 1, endLine: 1 }, children: [], arguments: [], typeArguments: [] }, { id: "name", kind: "literal", value: "/settings", range: { startLine: 3, endLine: 3 }, children: [], arguments: [], typeArguments: [] }, { id: "push", kind: "call", name: "pushNamed", ownerSymbolId: "nav", range: { startLine: 3, endLine: 3 }, children: [], arguments: [{ valueId: "name" }], typeArguments: [] }] } } as never }], } as never;
  const result = flutterAdapter.analyze(context);
  const materialized = resolveFrameworkEvidence(context, result.evidence);
  assert.equal(materialized.entities[0]?.displayName, "/settings");
  assert.equal(materialized.relationships.some((item) => item.relationKind === "navigation_binding"), true);
});
