import test from "node:test";
import assert from "node:assert/strict";

import { createDeliveredSnapshot, contentIdentity } from "../src/core/context/context-snapshot.js";

test("delivered snapshots use deterministic content identity and retain exact content", () => {
  const snapshot = createDeliveredSnapshot({
    snapshotId: "snapshot-1", receiptId: "receipt-1", subjectIdentity: "subject-1", projectionIdentity: "projection-1",
  }, "export const value = 1;\n");
  assert.equal(snapshot.content, "export const value = 1;\n");
  assert.equal(snapshot.contentIdentity, contentIdentity(snapshot.content));
  assert.notEqual(snapshot.contentIdentity, contentIdentity("export const value = 2;\n"));
});

test("a content hash alone is not a reconstructable previous snapshot", () => {
  const hash = contentIdentity("previous");
  assert.equal(typeof hash, "string");
  assert.throws(() => createDeliveredSnapshot({
    snapshotId: "snapshot-1", receiptId: "receipt-1", subjectIdentity: "subject-1", projectionIdentity: "projection-1",
  }, undefined as unknown as string), /content/);
});
