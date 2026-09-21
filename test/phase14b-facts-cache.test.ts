import assert from "node:assert/strict";
import test from "node:test";

import { decodeFacts, encodeFacts } from "../src/core/facts/facts-codec.js";
import { factBlobKey } from "../src/core/facts/facts-identity.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import { expectation, makeFacts } from "./helpers/phase14b-facts.js";

test("v3 facts round-trip and v2 facts miss without mutation", () => {
  const v3 = makeFacts({
    factsSchemaVersion: "3.0.0",
    factsVersion: "3.0.0",
  });
  const encoded = encodeFacts(v3);

  assert.deepEqual(
    decodeFacts(encoded, { key: factBlobKey(v3), ...expectation(v3) }),
    { kind: "hit", facts: v3 },
  );

  const v2 = makeFacts({
    factsSchemaVersion: "2.0.0",
    factsVersion: "2.0.0",
  });
  assert.notEqual(factBlobKey(v3), factBlobKey(v2));
  assert.equal(
    decodeFacts(encodeFacts(v2), {
      key: factBlobKey(v3),
      ...expectation(v3),
    }).kind,
    "miss",
  );
  assert.equal(CURRENT_INDEX_VERSION_DOMAINS.factsVersion, "3.0.0");
  assert.equal(CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion, "3.0.0");
});
