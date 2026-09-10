import assert from "node:assert/strict";
import test from "node:test";

import { analyzeFramework, builtinFrameworkAdapters, detectFrameworks } from "../src/core/framework/framework-registry.js";

test("React/Next adapter is registered deterministically and preserves separate detections", () => {
  assert.deepEqual(builtinFrameworkAdapters.map((adapter) => adapter.id).sort(), ["nestjs", "react-next", "spring"]);
  const context = {
    repositoryId: "repo",
    facts: [],
    graph: { nodes: [], edges: [] },
    config: [{ relativePath: "package.json", scope: "root", inputKey: "package:root", kind: "package" as const, values: { react: "19.0.0", next: "15.0.0" }, complete: true }],
  };
  const detections = detectFrameworks(context, builtinFrameworkAdapters);
  assert.deepEqual(detections.map((item) => item.framework), ["next", "react"]);
  const materialization = analyzeFramework({ ...context, generationId: "generation", frameworkResolutionVersion: "1.0.0", detections, analyzePaths: new Set(), maxObservations: 100 }, builtinFrameworkAdapters);
  assert.equal(materialization.complete, true);
  assert.deepEqual(materialization.dependencies, []);
});
