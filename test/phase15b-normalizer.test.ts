import assert from "node:assert/strict";
import test from "node:test";

import { normalizeTaskContextInput } from "../src/core/context/task-context-normalizer.js";

test("normalizes task text without changing identifiers or line boundaries", () => {
  const normalized = normalizeTaskContextInput({
    task: "  Fix fooBar\r\n\tkeep HTTPServer and $value  \n",
  });

  assert.equal(normalized.task, "Fix fooBar\nkeep HTTPServer and $value");
});

test("normalizes, sorts, and deduplicates anchors and changed paths", () => {
  const normalized = normalizeTaskContextInput({
    task: "find it",
    anchors: [
      { kind: "symbol", path: "src\\z.ts", name: "Zed" },
      { kind: "file", path: "src/a.ts" },
      { kind: "file", path: "src/a.ts" },
      { kind: "symbol", name: "Alpha" },
    ],
    changedPaths: ["src\\z.ts", "src/a.ts", "src/a.ts"],
  });

  assert.deepEqual(normalized.anchors, [
    { kind: "file", path: "src/a.ts" },
    { kind: "symbol", name: "Alpha" },
    { kind: "symbol", path: "src/z.ts", name: "Zed" },
  ]);
  assert.deepEqual(normalized.changedPaths, ["src/a.ts", "src/z.ts"]);
});

test("rejects empty, absolute, and traversal paths", () => {
  assert.throws(() => normalizeTaskContextInput({ task: "" }), /task/);
  assert.throws(() => normalizeTaskContextInput({ task: "x", changedPaths: ["/tmp/x.ts"] }), /path/);
  assert.throws(() => normalizeTaskContextInput({ task: "x", anchors: [{ kind: "file", path: "../x.ts" }] }), /path/);
});
