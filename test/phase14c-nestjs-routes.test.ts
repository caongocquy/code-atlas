import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeNestRoute, nestjsAdapter } from "../src/core/framework/adapters/nestjs.js";

test("canonicalizes a Nest GET route with a parameter", () => {
  const route = canonicalizeNestRoute({ framework: "nestjs", scope: "api", router: "http", kind: "route", path: "/users/:id", method: "GET", conditions: [], owner: null });
  assert.equal(route.kind, "canonical");
  if (route.kind === "canonical") assert.ok(route.ref.logicalKey.includes("GET"));
});

test("detects configured Nest without treating plain TypeScript as Nest", () => {
  assert.equal(nestjsAdapter.detect({ repositoryId: "repo", graph: { nodes: [], edges: [] }, facts: [], config: [{ relativePath: "package.json", scope: "root", inputKey: "package:root", kind: "package", values: { "@nestjs/common": "10.0.0" }, complete: true }] })[0]?.framework, "nestjs");
  assert.deepEqual(nestjsAdapter.detect({ repositoryId: "repo", graph: { nodes: [], edges: [] }, facts: [], config: [] }), []);
});
