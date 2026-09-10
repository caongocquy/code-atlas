import assert from "node:assert/strict";
import test from "node:test";
import { canonicalizeFlutterRoute } from "../src/core/framework/adapters/flutter.js";

test("canonicalizes a Flutter named route without web normalization", () => {
  const route = canonicalizeFlutterRoute({ framework: "flutter", scope: "app", router: "material:App", kind: "route", path: "/settings", method: null, conditions: [], owner: null });
  assert.equal(route.kind, "canonical");
  if (route.kind === "canonical") assert.ok(route.ref.logicalKey.includes("/settings"));
});
