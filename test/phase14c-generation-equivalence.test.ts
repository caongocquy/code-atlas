import assert from "node:assert/strict";
import test from "node:test";
import { projectFrameworkGraph } from "../src/core/graph/query/framework-query.service.js";

test("projection remains equivalent when generation transport ids differ", () => {
  const base = { frameworkResolutionVersion: "1.0.0", entities: [], relationships: [], classifications: [], diagnostics: [], coverage: [], config: [], detections: [], dependencies: [], complete: true };
  const first = projectFrameworkGraph({ nodes: [], edges: [] }, { ...base, repositoryId: "repo", generationId: "one" });
  const second = projectFrameworkGraph({ nodes: [], edges: [] }, { ...base, repositoryId: "repo", generationId: "two" });
  assert.deepEqual(first, second);
});
