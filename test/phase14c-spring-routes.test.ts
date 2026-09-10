import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeSpringRoute, springAdapter } from "../src/core/framework/adapters/spring.js";

test("canonicalizes a Spring route with brace parameters", () => {
  const route = canonicalizeSpringRoute({ framework: "spring", scope: "service", router: "mvc", kind: "route", path: "/users/{id}", method: "GET", conditions: [], owner: null });
  assert.equal(route.kind, "canonical");
  if (route.kind === "canonical") assert.ok(route.ref.logicalKey.includes("/users/{id}"));
});

test("detects observed Spring imports separately from plain JVM code", () => {
  assert.equal(springAdapter.detect({ repositoryId: "repo", graph: { nodes: [], edges: [] }, facts: [{ relativePath: "App.java", facts: { imports: [{ moduleSpecifier: "org.springframework.web.bind.annotation.RestController" }] } as never }], config: [] })[0]?.framework, "spring");
  assert.deepEqual(springAdapter.detect({ repositoryId: "repo", graph: { nodes: [], edges: [] }, facts: [], config: [] }), []);
});
