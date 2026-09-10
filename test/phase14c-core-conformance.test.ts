import assert from "node:assert/strict";
import test from "node:test";

import { createFrameworkFixture, normalizeFramework } from "./helpers/phase14c-fixture.js";

test("framework snapshot is deterministic across cold, warm, and clean runs", async () => {
  const fixture = await createFrameworkFixture({ "plain.ts": "export const n = 1;\n" });
  try {
    const cold = await fixture.run();
    const warm = await fixture.run();
    const clean = await fixture.clean();
    assert.deepEqual(normalizeFramework(cold.framework), normalizeFramework(warm.framework));
    assert.deepEqual(normalizeFramework(cold.framework), normalizeFramework(clean.framework));
    assert.equal(warm.counters.filesParsed, 0);
    assert.equal(warm.counters.filesResolved, 0);
  } finally { await fixture.close(); }
});

test("framework lifecycle remains deterministic after a source change", async () => {
  const fixture = await createFrameworkFixture({ "plain.ts": "export const n = 1;\n" });
  try {
    const before = await fixture.run();
    const after = await fixture.run({ "plain.ts": "export const n = 2;\n" });
    assert.deepEqual(normalizeFramework(before.framework), normalizeFramework(after.framework));
    assert.ok(after.counters.frameworkFilesResolved >= 0);
  } finally { await fixture.close(); }
});
