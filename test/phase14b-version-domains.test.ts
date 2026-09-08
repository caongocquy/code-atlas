import assert from "node:assert/strict";
import test from "node:test";

import { GRAPH_INDEX_VERSION } from "../src/config/constants.js";
import {
  CURRENT_INDEX_VERSION_DOMAINS,
  FACTS_SCHEMA_VERSION,
} from "../src/core/repository/index-version.js";

test("version domains expose independent facts schema and resolution versions", () => {
  assert.deepEqual(Object.keys(CURRENT_INDEX_VERSION_DOMAINS).sort(), [
    "derivedVersion", "factsSchemaVersion", "factsVersion", "resolutionVersion", "schemaVersion",
  ]);
  assert.notEqual(CURRENT_INDEX_VERSION_DOMAINS.resolutionVersion, GRAPH_INDEX_VERSION);
  assert.equal(CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion, FACTS_SCHEMA_VERSION);
});
