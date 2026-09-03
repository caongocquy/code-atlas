import test from "node:test";
import assert from "node:assert/strict";

import { runCopyOnWriteGeneration } from "../src/utils/copy-on-write.js";

test("vector copy-on-write keeps the old generation when staging fails", async () => {
  let activeGeneration = "old";
  const generations = new Set(["old"]);
  let activated = false;
  let cleaned = false;

  await assert.rejects(
    runCopyOnWriteGeneration({
      stage: async () => {
        generations.add("new");
        throw new Error("embedding failed");
      },
      activate: async (generation) => {
        activeGeneration = generation;
        activated = true;
      },
      cleanup: async (generation) => {
        generations.delete(generation);
        cleaned = true;
      },
    }),
    /embedding failed/,
  );

  assert.equal(activeGeneration, "old");
  assert.equal(generations.has("old"), true);
  assert.equal(activated, false);
  assert.equal(cleaned, false);
});
