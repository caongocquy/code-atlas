import test from "node:test";
import assert from "node:assert/strict";

import {
  graphRefreshMode,
  vectorRefreshMode,
} from "../src/utils/index-version.js";

test("graph version mismatch selects a full rebuild without changing the version", () => {
  assert.equal(graphRefreshMode("before", "current"), "full-rebuild");
  assert.equal(graphRefreshMode("current", "current"), "incremental");
});

test("vector version mismatch selects semantic reindex without changing the version", () => {
  assert.equal(vectorRefreshMode("before", "current"), "semantic-reindex");
  assert.equal(vectorRefreshMode("current", "current"), "incremental");
});
