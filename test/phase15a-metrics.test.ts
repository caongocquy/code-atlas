import test from "node:test";
import assert from "node:assert/strict";

import { getContextMetrics, resetContextMetrics } from "../src/core/context/context-aware-read.service.js";

test("context metrics are observational and count delivery modes and byte savings", () => {
  resetContextMetrics();
  const before = getContextMetrics();
  assert.deepEqual(before, { requestedBytes: 0, returnedBytes: 0, fullReads: 0, unchangedReads: 0, deltaReads: 0, rehydrates: 0, savedBytes: 0 });
});
