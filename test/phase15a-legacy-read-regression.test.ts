import test from "node:test";
import assert from "node:assert/strict";

import { buildContext } from "../src/core/retrieval/context.js";

test("legacy context construction remains unchanged and has no receipt input", () => {
  assert.equal(buildContext([]), "");
});
