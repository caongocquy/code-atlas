import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeNestRoute, nestjsAdapter } from "../src/core/framework/adapters/nestjs.js";
import { resolveFrameworkEvidence } from "../src/core/framework/framework-registry.js";

test("canonicalizes a Nest GET route with a parameter", () => {
  const route = canonicalizeNestRoute({ framework: "nestjs", scope: "api", router: "http", kind: "route", path: "/users/:id", method: "GET", conditions: [], owner: null });
  assert.equal(route.kind, "canonical");
  if (route.kind === "canonical") assert.ok(route.ref.logicalKey.includes("GET"));
});

test("detects configured Nest without treating plain TypeScript as Nest", () => {
  assert.equal(nestjsAdapter.detect({ repositoryId: "repo", graph: { nodes: [], edges: [] }, facts: [], config: [{ relativePath: "package.json", scope: "root", inputKey: "package:root", kind: "package", values: { "@nestjs/common": "10.0.0" }, complete: true }] })[0]?.framework, "nestjs");
  assert.deepEqual(nestjsAdapter.detect({ repositoryId: "repo", graph: { nodes: [], edges: [] }, facts: [], config: [] }), []);
});

test("materializes an explicit controller route with its canonical entity", () => {
  const context = { repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["app.ts"]), maxObservations: 20, config: [], graph: { nodes: [{ id: "controller", type: "class", name: "UsersController", file: "app.ts", startLine: 1, endLine: 8 }, { id: "handler", type: "method", name: "find", file: "app.ts", startLine: 3, endLine: 4 }], edges: [{ from: "controller", to: "handler", type: "contains" }] }, facts: [{ relativePath: "app.ts", facts: { imports: [{ moduleSpecifier: "@nestjs/common" }], frameworkSyntax: { complete: true, nodes: [{ id: "controller-annotation", kind: "annotation", name: "Controller", ownerSymbolId: "controller", range: { startLine: 1, endLine: 1 }, children: [], arguments: [{ valueId: "users" }], typeArguments: [] }, { id: "users", kind: "literal", value: "users", range: { startLine: 1, endLine: 1 }, children: [], arguments: [], typeArguments: [] }, { id: "get-annotation", kind: "annotation", name: "Get", ownerSymbolId: "handler", range: { startLine: 2, endLine: 2 }, children: [], arguments: [{ valueId: "id" }], typeArguments: [] }, { id: "id", kind: "literal", value: ":id", range: { startLine: 2, endLine: 2 }, children: [], arguments: [], typeArguments: [] }] } } as never }], } as never;
  const result = nestjsAdapter.analyze(context);
  const materialized = resolveFrameworkEvidence(context, result.evidence);
  assert.equal(materialized.relationships[0]?.relationKind, "controller_route");
  assert.deepEqual(materialized.relationships[0]?.source, { kind: "language", nodeId: "handler" });
  assert.equal(materialized.entities[0]?.ref.framework, "nestjs");
});
