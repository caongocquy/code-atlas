import assert from "node:assert/strict";
import test from "node:test";

import { planFrameworkInvalidation } from "../src/core/framework/framework-invalidation.js";
import type { FrameworkSnapshot } from "../src/core/framework/framework.types.js";
import { frameworkChangedLookupKeys } from "../src/core/indexing/index-pipeline.service.js";

const previous = (dependencies: FrameworkSnapshot["dependencies"] = []): FrameworkSnapshot => ({
  repositoryId: "repo",
  generationId: "generation",
  frameworkResolutionVersion: "1.0.0",
  entities: [], relationships: [], classifications: [], diagnostics: [], coverage: [], config: [], detections: [],
  dependencies,
  complete: true,
});

test("missing or incomplete framework state widens analysis", () => {
  const plan = planFrameworkInvalidation({ paths: ["a.ts"], allPaths: ["a.ts"], changedInputKeys: new Set(), changedLookupKeys: new Set(), frameworkResolutionVersion: "1.0.0", topologyComplete: false });
  assert.deepEqual(plan.analyzePaths, ["a.ts"]);
  assert.equal(plan.widened, true);
});

test("unrelated files are reusable when framework dependencies are unchanged", () => {
  const plan = planFrameworkInvalidation({ paths: [], allPaths: ["a.ts", "b.ts"], changedInputKeys: new Set(), changedLookupKeys: new Set(), previous: previous(), frameworkResolutionVersion: "1.0.0", topologyComplete: true });
  assert.deepEqual(plan.analyzePaths, []);
  assert.deepEqual(plan.reusePaths, ["a.ts", "b.ts"]);
  assert.equal(plan.widened, false);
});

test("changed input and lookup keys invalidate dependency owners", () => {
  const dependency = { framework: "next" as const, scope: "app", ownerPath: "app/users/page.tsx", inputKeys: ["route:users"], lookupKeys: ["handler:users"], complete: true };
  const input = planFrameworkInvalidation({ paths: ["app/users/page.tsx"], allPaths: ["app/users/page.tsx", "plain.ts"], changedInputKeys: new Set(["route:users"]), changedLookupKeys: new Set(), previous: previous([dependency]), frameworkResolutionVersion: "1.0.0", topologyComplete: true });
  assert.deepEqual(input.analyzePaths, ["app/users/page.tsx"]);
  const lookup = planFrameworkInvalidation({ paths: [], allPaths: ["app/users/page.tsx", "plain.ts"], changedInputKeys: new Set(), changedLookupKeys: new Set(["handler:users"]), previous: previous([dependency]), frameworkResolutionVersion: "1.0.0", topologyComplete: true });
  assert.deepEqual(lookup.analyzePaths, ["app/users/page.tsx"]);
});

test("changed paths are distinct from the full rebuild universe", () => {
  const dependency = { framework: "next" as const, scope: "app", ownerPath: "app/page.tsx", inputKeys: [], lookupKeys: [], complete: true };
  const plan = planFrameworkInvalidation({ paths: ["app/page.tsx"], allPaths: ["app/page.tsx", "plain.ts"], changedInputKeys: new Set(), changedLookupKeys: new Set(), previous: previous([dependency]), frameworkResolutionVersion: "1.0.0", topologyComplete: true });
  assert.deepEqual(plan.analyzePaths, ["app/page.tsx"]);
  assert.deepEqual(plan.reusePaths, ["plain.ts"]);
});

test("version changes widen without requiring language paths to be reparsed", () => {
  const plan = planFrameworkInvalidation({ paths: [], allPaths: ["a.ts", "b.ts"], changedInputKeys: new Set(), changedLookupKeys: new Set(), previous: previous(), frameworkResolutionVersion: "2.0.0", topologyComplete: true });
  assert.deepEqual(plan.analyzePaths, ["a.ts", "b.ts"]);
  assert.equal(plan.reasons.includes("framework_resolution_version_changed"), true);
});

test("changed materialized facts invalidate semantic lookup dependents", () => {
  const keys = frameworkChangedLookupKeys(
    { dependencies: [{ lookupKeys: ["jsx:UI.Button", "inject:Service"] }] },
    [{ relativePath: "Button.tsx", facts: { symbols: [{ name: "Button" }], parameters: [{ typeText: "Service" }], frameworkSyntax: { nodes: [], complete: true } } as never }],
    { changedFiles: ["Button.tsx"], deletedFiles: [] },
  );
  assert.deepEqual([...keys].sort(), ["Button.tsx", "inject:Service", "jsx:UI.Button"]);
});

test("deleted provider facts invalidate qualified lookup dependents", () => {
  const keys = frameworkChangedLookupKeys(
    { dependencies: [{ lookupKeys: ["jsx:UI.Button", "inject:Service"] }] },
    [],
    { changedFiles: [], deletedFiles: ["Button.tsx"] },
    { nodes: [{ id: "button", type: "class", name: "UI.Button", file: "Button.tsx" }] } as never,
  );
  assert.deepEqual([...keys].sort(), ["jsx:UI.Button"]);
});
