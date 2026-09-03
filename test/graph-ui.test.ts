import assert from "node:assert/strict";
import test from "node:test";

import { toSigmaNodeAttributes } from "../web/src/graph.js";

test("Sigma node mapping keeps semantic types out of the renderer type attribute", () => {
  const attributes = toSigmaNodeAttributes(
    { id: "variable-1", type: "variable", name: "store", file: "src/foo.ts" },
    { x: 1, y: 2 },
    8,
    1,
    "#9fb8d5",
  );

  assert.equal(attributes.nodeType, "variable");
  assert.equal(Object.hasOwn(attributes, "type"), false);
});
