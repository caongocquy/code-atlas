import assert from "node:assert/strict";
import test from "node:test";

import { decodeFacts, encodeFacts } from "../src/core/facts/facts-codec.js";
import { factBlobKey } from "../src/core/facts/facts-identity.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import { expectation, makeFacts } from "./helpers/phase14b-facts.js";

test("v2 facts round-trip and legacy facts miss without mutation", () => {
  const v2 = makeFacts({
    factsSchemaVersion: "2.0.0",
    factsVersion: "2.0.0",
  });
  const encoded = encodeFacts(v2);

  assert.deepEqual(
    decodeFacts(encoded, { key: factBlobKey(v2), ...expectation(v2) }),
    { kind: "hit", facts: v2 },
  );

  const legacy = makeFacts({
    factsSchemaVersion: "1.0.0",
    factsVersion: "1.0.0",
  });
  assert.notEqual(factBlobKey(v2), factBlobKey(legacy));
  assert.equal(
    decodeFacts(encodeFacts(legacy), {
      key: factBlobKey(v2),
      ...expectation(v2),
    }).kind,
    "miss",
  );
  assert.equal(CURRENT_INDEX_VERSION_DOMAINS.factsVersion, "2.0.0");
  assert.equal(CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion, "2.0.0");
});
