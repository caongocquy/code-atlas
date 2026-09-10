import assert from "node:assert/strict";
import test from "node:test";

import { canonicalizeFrameworkEntity, resolveFrameworkEvidence } from "../src/core/framework/framework-registry.js";
import type { FrameworkAnalysisContext, FrameworkEvidence } from "../src/core/framework/framework.types.js";

const context = { frameworkResolutionVersion: "1.0.0", config: [], detections: [] } as unknown as FrameworkAnalysisContext;

test("canonicalizes routes with stable method and condition order", () => {
  const result = canonicalizeFrameworkEntity({ framework: "nestjs", scope: "api", router: "http", kind: "route", path: "/users/:id", method: "get", conditions: ["z", "a", "a"], owner: null });
  assert.equal(result.kind, "canonical");
  if (result.kind === "canonical") assert.equal(result.ref.logicalKey, JSON.stringify(["api", "http", "/users/:id", "GET", ["a", "z"], null]));
});

test("drops ambiguous relationships and unary classifications", () => {
  const evidence: FrameworkEvidence[] = [
    { evidenceId: "rel", framework: "next", adapterId: "a", adapterVersion: "1", strategy: "s", capability: "route", relativePath: "app/page.tsx", origin: "framework_inferred", confidence: "exact", refs: [{ relativePath: "app/page.tsx", inputKey: "facts" }], entities: [], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "relationship", relationKind: "route_binding", sourceCandidates: [], targetCandidates: [] },
    { evidenceId: "cls", framework: "next", adapterId: "a", adapterVersion: "1", strategy: "s", capability: "boundary", relativePath: "app/page.tsx", origin: "framework_inferred", confidence: "exact", refs: [{ relativePath: "app/page.tsx", inputKey: "facts" }], entities: [], applicable: true, supported: true, attempted: true, state: "candidate", outputKind: "classification", classificationKind: "execution_boundary", subjectCandidates: [], values: ["client", "server"] },
  ];
  const result = resolveFrameworkEvidence(context, evidence);
  assert.deepEqual(result.relationships, []);
  assert.deepEqual(result.classifications, []);
  assert.equal(result.diagnostics.length, 2);
});
