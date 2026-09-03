import test from "node:test";
import assert from "node:assert/strict";

import {
  formatIncrementalSync,
  formatProgress,
  formatSummary,
} from "../src/cli/format.js";

test("CLI formatters keep counts readable without relying on color", () => {
  assert.match(formatProgress(5, 10, "graph"), /50%\s+5\/10/);
  assert.match(formatSummary("Graph indexed", [
    { label: "Added", value: 1, tone: "warning" },
    { label: "Deleted", value: 0, tone: "warning" },
  ], "graph"), /Added\s+1/);
  assert.match(formatIncrementalSync(1, 2, 0), /\+1 added/);
  assert.match(formatIncrementalSync(1, 2, 0), /~2 changed/);
  assert.match(formatIncrementalSync(1, 2, 0), /-0 deleted/);
});
