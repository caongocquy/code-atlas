import assert from "node:assert/strict";
import test from "node:test";

// @ts-expect-error JavaScript-only CI diagnostics intentionally have no declaration file.
import { auditTestIdentityDrift } from "../scripts/ca01-test-identity-audit.mjs";

const row = (name: string, column: number, type = "test:pass") => ({
  type, identity: { file: "test/demo.test.ts", line: 1, column, nesting: 0, name },
  skip: false, todo: false,
});

test("CA-01 identity audit distinguishes passing source drift from a deleted test", () => {
  const report = auditTestIdentityDrift([row("moved", 10), row("removed", 20)], [row("moved", 30)]);
  assert.equal(report.moved.length, 1);
  assert.equal(report.removed.length, 1);
  assert.equal(report.outcomeChanges.length, 0);
  assert.equal(report.gateDecision, "DIAGNOSTIC_ONLY_NO_WAIVER");
});

test("CA-01 identity audit refuses to label changed outcomes as location-only drift", () => {
  const report = auditTestIdentityDrift([row("drift", 10), row("unchanged", 20)],
    [row("drift", 11, "test:fail"), row("unchanged", 20, "test:fail")]);
  assert.equal(report.moved.length, 1);
  assert.equal(report.outcomeChanges.length, 2);
  assert.deepEqual(report.outcomeChanges.map((entry: { after: string }) => entry.after), ["test:fail", "test:fail"]);
});

test("CA-01 identity audit fails closed on duplicate and ambiguous names", () => {
  assert.throws(() => auditTestIdentityDrift([row("dup", 10), row("dup", 10)], []), /Duplicate/);
  const report = auditTestIdentityDrift([row("same", 10)], [row("same", 11), row("same", 12)]);
  assert.equal(report.ambiguous.length, 1);
  assert.equal(report.moved.length, 0);
});

test("CA-01 identity audit preserves evidence of new passing tests", () => {
  const report = auditTestIdentityDrift([row("original", 10)], [row("original", 10), row("new", 20)]);
  assert.equal(report.added.length, 1);
  assert.equal(report.removed.length, 0);
});
