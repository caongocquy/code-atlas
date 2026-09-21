import test from "node:test";
import assert from "node:assert/strict";

import type { SearchResult } from "../src/core/retrieval/code-search.service.js";
import { buildContext } from "../src/core/retrieval/context.js";

test("retrieval context preserves source evidence for external consumers", () => {
  const chunks: SearchResult[] = [
    {
      score: 0.42,
      file: "src/example.ts",
      symbolName: "run",
      symbolType: "function",
      startLine: 1,
      endLine: 3,
      content: "function run() { return true; }",
    },
  ];
  const context = buildContext(chunks);

  assert.match(context, /src\/example\.ts/);
  assert.match(context, /function run/);
});
