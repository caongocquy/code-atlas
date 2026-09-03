import test from "node:test";
import assert from "node:assert/strict";

import type { SearchResult } from "../src/core/retrieval/code-search.service.js";
import { buildCodebaseMessages } from "../src/core/retrieval/prompt.js";
import { buildContext } from "../src/core/retrieval/context.js";

test("inspector prompt uses the exact context representation sent to the model", () => {
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
  const messages = buildCodebaseMessages("where is run?", context);

  assert.equal(messages[1]?.content.endsWith(context), true);
  assert.match(messages[1]?.content ?? "", /Question:\nwhere is run\?/);
});
