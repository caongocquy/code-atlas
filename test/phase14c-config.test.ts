import assert from "node:assert/strict";
import test from "node:test";

import { materializeFrameworkConfig } from "../src/core/framework/framework-config.js";

test("materializes scoped project configuration deterministically", () => {
  assert.deepEqual(materializeFrameworkConfig([]), []);
  const [config] = materializeFrameworkConfig([{
    relativePath: "apps/web/package.json",
    contentHash: "abc",
    kind: "package",
    objectiveValues: { dependencies: { next: "15.0.0" } },
    complete: true,
  }]);
  assert.equal(config?.scope, "apps/web");
  assert.equal(config?.inputKey, "package:apps/web/package.json:abc");
  assert.equal(config?.complete, true);
});

test("sorts inputs and preserves incomplete/deleted-compatible records", () => {
  const result = materializeFrameworkConfig([
    { relativePath: "z/package.json", contentHash: "2", kind: "package", objectiveValues: {}, complete: false },
    { relativePath: "a/pubspec.yaml", contentHash: "1", kind: "pubspec", objectiveValues: {}, complete: true },
    { relativePath: "deleted/package.json", contentHash: "", kind: "package", objectiveValues: {}, complete: false },
  ]);
  assert.deepEqual(result.map((item) => item.relativePath), ["a/pubspec.yaml", "z/package.json"]);
  assert.equal(result[1]?.complete, false);
});

test("does not share mutable objective values between materialized records", () => {
  const values = { dependencies: { next: "15.0.0" } };
  const [config] = materializeFrameworkConfig([{
    relativePath: "package.json",
    contentHash: "abc",
    kind: "package",
    objectiveValues: values,
    complete: true,
  }]);
  assert.notEqual(config?.values, values);
  assert.notEqual(config?.values.dependencies, values.dependencies);
});
