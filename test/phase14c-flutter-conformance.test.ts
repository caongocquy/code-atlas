import assert from "node:assert/strict";
import test from "node:test";
import { analyzeFramework, builtinFrameworkAdapters, detectFrameworks } from "../src/core/framework/framework-registry.js";

test("Flutter is independently registered and plain Dart stays outside Flutter", () => {
  assert.deepEqual(builtinFrameworkAdapters.map((adapter) => adapter.id).sort(), ["flutter", "nestjs", "react-next", "spring"]);
  const context = { repositoryId: "repo", facts: [], graph: { nodes: [], edges: [] }, config: [] };
  const detections = detectFrameworks(context, builtinFrameworkAdapters);
  assert.deepEqual(detections, []);
  const result = analyzeFramework({ ...context, generationId: "generation", frameworkResolutionVersion: "1.0.0", detections, analyzePaths: new Set(), maxObservations: 100 }, builtinFrameworkAdapters);
  assert.equal(result.relationships.length, 0);
});
