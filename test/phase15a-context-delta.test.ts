import test from "node:test";
import assert from "node:assert/strict";

import { applyDelta, createExactDelta } from "../src/core/context/context-delta.js";
import { contentIdentity } from "../src/core/context/context-snapshot.js";

test("exact delta is deterministic, serializable, and reconstructs additions, removals, and replacements", () => {
  for (const [previous, current] of [["old", "new"], ["", "added"], ["removed", ""]] as const) {
    const delta = createExactDelta(previous, current);
    assert.deepEqual(JSON.parse(JSON.stringify(delta)), delta);
    const reconstructed = applyDelta(previous, delta);
    assert.equal(reconstructed, current);
    assert.equal(contentIdentity(reconstructed), contentIdentity(current));
  }
});

test("tampered exact delta is rejected by reconstruction validation", () => {
  const delta = createExactDelta("old", "new");
  assert.throws(() => applyDelta("old", { ...delta, content: "wrong" }), /identity|delta/i);
});
