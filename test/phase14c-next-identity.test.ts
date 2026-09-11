import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeNextRoute } from "../src/core/framework/adapters/react-next.js";

test("canonicalizes a scoped Next route deterministically", () => {
  const route = canonicalizeNextRoute({ framework: "next", scope: "apps/web", router: "app", kind: "route", path: "/users", method: null, conditions: [], owner: null });
  assert.equal(route.kind, "canonical");
  if (route.kind === "canonical") assert.equal(route.ref.logicalKey, JSON.stringify(["apps/web", "app", "/users", null, [], null]));
});

test("rejects a non-Next route", () => {
  assert.equal(canonicalizeNextRoute({ framework: "react", scope: "apps/web", router: "app", kind: "route", path: "/users", method: null, conditions: [], owner: null }).kind, "unresolved");
});

test("rejects repeated Next route separators instead of collapsing them", () => {
  assert.equal(canonicalizeNextRoute({ framework: "next", scope: "root", router: "app", kind: "route", path: "/users//id", method: null, conditions: [], owner: null }).kind, "unresolved");
});
