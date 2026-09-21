import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeSpringRoute, springAdapter } from "../src/core/framework/adapters/spring.js";
import { resolveFrameworkEvidence } from "../src/core/framework/framework-registry.js";

test("canonicalizes a Spring route with brace parameters", () => {
  const route = canonicalizeSpringRoute({ framework: "spring", scope: "service", router: "mvc", kind: "route", path: "/users/{id}", method: "GET", conditions: [], owner: null });
  assert.equal(route.kind, "canonical");
  if (route.kind === "canonical") assert.ok(route.ref.logicalKey.includes("/users/{id}"));
});

test("detects observed Spring imports separately from plain JVM code", () => {
  assert.equal(springAdapter.detect({ repositoryId: "repo", graph: { nodes: [], edges: [] }, facts: [{ relativePath: "App.java", facts: { imports: [{ moduleSpecifier: "org.springframework.web.bind.annotation.RestController" }] } as never }], config: [] })[0]?.framework, "spring");
  assert.deepEqual(springAdapter.detect({ repositoryId: "repo", graph: { nodes: [], edges: [] }, facts: [], config: [] }), []);
});

test("materializes an explicit Spring request mapping", () => {
  const context = { repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["Users.java"]), maxObservations: 20, config: [], graph: { nodes: [{ id: "controller", type: "class", name: "Users", file: "Users.java", startLine: 1, endLine: 8 }, { id: "handler", type: "method", name: "find", file: "Users.java", startLine: 3, endLine: 4 }], edges: [{ from: "controller", to: "handler", type: "contains" }] }, facts: [{ relativePath: "Users.java", facts: { imports: [{ moduleSpecifier: "org.springframework.web.bind.annotation.GetMapping" }], frameworkSyntax: { complete: true, nodes: [{ id: "controller-annotation", kind: "annotation", name: "RestController", ownerSymbolId: "controller", range: { startLine: 1, endLine: 1 }, children: [], arguments: [], typeArguments: [] }, { id: "mapping", kind: "annotation", name: "GetMapping", ownerSymbolId: "handler", range: { startLine: 2, endLine: 2 }, children: [], arguments: [{ valueId: "users" }], typeArguments: [] }, { id: "users", kind: "literal", value: "/users/{id}", range: { startLine: 2, endLine: 2 }, children: [], arguments: [], typeArguments: [] }] } } as never }], } as never;
  const result = springAdapter.analyze(context);
  const materialized = resolveFrameworkEvidence(context, result.evidence);
  assert.equal(materialized.relationships[0]?.relationKind, "controller_route");
  assert.equal(materialized.entities[0]?.displayName.includes("/users/{id}"), true);
});
