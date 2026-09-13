import assert from "node:assert/strict";
import test from "node:test";

import { CONTEXT_SUBJECT_SELECTOR_VERSION } from "../src/core/context/context.types.js";
import { canonicalContextSubjectKey, createTaskIdentity, normalizeTaskContextInput } from "../src/core/context/task-context-normalizer.js";

test("task identity is versioned and uses only normalized task inputs", () => {
  const first = normalizeTaskContextInput({
    task: "  inspect fooBar ",
    anchors: [{ kind: "file", path: "src/index.ts" }],
    changedPaths: ["src/index.ts"],
    budget: { maxItems: 1 },
  });
  const equivalent = normalizeTaskContextInput({
    task: "inspect fooBar",
    anchors: [{ kind: "file", path: "src/index.ts" }],
    changedPaths: ["src/index.ts"],
  });

  assert.match(createTaskIdentity(first), /^task-v1:[0-9a-f]{64}$/);
  assert.equal(createTaskIdentity(first), createTaskIdentity(equivalent));
  assert.notEqual(createTaskIdentity(first), createTaskIdentity(normalizeTaskContextInput({ task: "inspect other" })));
  assert.notEqual(createTaskIdentity(first), createTaskIdentity(normalizeTaskContextInput({ task: "inspect fooBar", changedPaths: ["src/other.ts"] })));
});

test("subject keys accept only the Phase15A file and symbol contract", () => {
  assert.equal(canonicalContextSubjectKey({ kind: "file", path: "src/index.ts" }).length, 64);
  assert.equal(canonicalContextSubjectKey({ kind: "symbol", path: "src/index.ts", symbolId: "fn:main", selectorVersion: CONTEXT_SUBJECT_SELECTOR_VERSION }).length, 64);
  assert.throws(() => canonicalContextSubjectKey({ kind: "range", path: "src/index.ts" } as never), /unsupported|subject/);
});
