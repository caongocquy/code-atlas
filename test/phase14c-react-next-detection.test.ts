import assert from "node:assert/strict";
import test from "node:test";

import { reactNextAdapter } from "../src/core/framework/adapters/react-next.js";

test("detects React and Next independently from config and imports", () => {
  const result = reactNextAdapter.detect({
    repositoryId: "repo",
    graph: { nodes: [], edges: [] },
    facts: [{ relativePath: "app/page.tsx", facts: { imports: [{ moduleSpecifier: "next/server" } as never] } as never }],
    config: [{ relativePath: "package.json", scope: "root", inputKey: "package:root", kind: "package", values: { next: "15.0.0", react: "19.0.0" }, complete: true }],
  });
  assert.deepEqual(result.map((item) => item.framework), ["react", "next"]);
  assert.equal(result[0]?.configured, true);
  assert.equal(result[1]?.observed, true);
});

test("does not infer framework presence from an unrelated package", () => {
  assert.deepEqual(reactNextAdapter.detect({ repositoryId: "repo", graph: { nodes: [], edges: [] }, facts: [], config: [{ relativePath: "package.json", scope: "root", inputKey: "package:root", kind: "package", values: { lodash: "1.0.0" }, complete: true }] }), []);
});
