import assert from "node:assert/strict";
import test from "node:test";
import { detectFrameworks, builtinFrameworkAdapters } from "../src/core/framework/framework-registry.js";

test("framework detection stays isolated by observed imports", () => {
  const detections = detectFrameworks({ repositoryId: "repo", facts: [{ relativePath: "app.ts", facts: { imports: [{ moduleSpecifier: "@nestjs/common" }] } as never }], graph: { nodes: [], edges: [] }, config: [] }, builtinFrameworkAdapters);
  assert.deepEqual(detections.map((item) => item.framework), ["nestjs"]);
});
