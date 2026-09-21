import test from "node:test";
import assert from "node:assert/strict";

import { decideContextMode } from "../src/core/context/context-decision.js";
import type { ContextReceipt, ContextSession, DeliveredSnapshot } from "../src/core/context/context.types.js";

const session: ContextSession = { sessionId: "s", repositoryIdentity: "r", workspaceIdentity: "w", createdAt: "2026-01-01T00:00:00.000Z", lastSeenAt: "2026-01-01T00:00:00.000Z", contextGeneration: "g", schemaVersion: 1 };
const receipt: ContextReceipt = { receiptId: "receipt", sessionId: "s", repositoryIdentity: "r", workspaceIdentity: "w", subject: { kind: "file", path: "a.ts" }, subjectIdentity: "subject", projectionIdentity: "projection", contextGeneration: "g", deliveryMode: "full", deliveredContentIdentity: "old", snapshotId: "snapshot", reliability: { authoritative: true }, deliveredAt: "2026-01-01T00:00:00.000Z", state: "active", schemaVersion: 1 };
const snapshot: DeliveredSnapshot = { snapshotId: "snapshot", receiptId: "receipt", subjectIdentity: "subject", projectionIdentity: "projection", content: "old", contentIdentity: "old", createdAt: "2026-01-01T00:00:00.000Z", schemaVersion: 1 };

function input(overrides: Record<string, unknown> = {}) {
  return { session, receipt, snapshot, currentContentIdentity: "new", subjectIdentity: "subject", projectionIdentity: "projection", now: "2026-01-02T00:00:00.000Z", exactDeltaAvailable: true, reconstructionValid: true, currentReadable: true, ...overrides };
}

test("decision engine distinguishes first full, unchanged, exact delta, and failed reuse", () => {
  assert.equal(decideContextMode(input({ receipt: undefined, snapshot: undefined, hasPriorReceipt: false })).mode, "full");
  assert.equal(decideContextMode(input({ currentContentIdentity: "old" })).mode, "unchanged");
  assert.equal(decideContextMode(input()).mode, "delta");
  assert.equal(decideContextMode(input({ snapshot: undefined })).mode, "rehydrate");
  assert.equal(decideContextMode(input({ reconstructionValid: false })).mode, "rehydrate");
});

test("decision engine rehydrates on expiry, mismatch, ambiguity, or unreadable current state", () => {
  for (const overrides of [
    { now: "2026-01-03T00:00:00.000Z", receipt: { ...receipt, expiresAt: "2026-01-02T00:00:00.000Z" } },
    { receipt: { ...receipt, workspaceIdentity: "other" } },
    { subjectIdentity: "other" },
    { exactDeltaAvailable: false },
    { currentReadable: false },
  ]) assert.equal(decideContextMode(input(overrides)).mode, "rehydrate");
});
