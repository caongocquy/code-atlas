import assert from "node:assert/strict";
import test from "node:test";
import { applyReviewedIdentityMigration } from "../scripts/ca01-reviewed-identity-migration.mjs";
import { compareReports } from "../scripts/compare-ca01-tests.mjs";

const before = { file: "test/example.test.ts", line: 1, column: 10, nesting: 0, name: "reviewed test" };
const after = { ...before, column: 30 };
const pair = { before, after };
const pass = (identity: typeof before) => ({ type: "test:pass", identity, skip: false, todo: false });
const baseline = [pass(before)];
const candidate = [pass(after)];

test("CA-01 reviewed migration preserves raw evidence and leaves unrelated identities unchanged", () => {
  const unrelated = pass({ ...after, name: "unrelated" });
  const result = applyReviewedIdentityMigration(baseline, [...candidate, unrelated], [pair]);
  assert.deepEqual(result, [pass(before), unrelated]);
  assert.deepEqual(candidate, [pass(after)]);
});

test("CA-01 reviewed migration rejects stale, duplicate, ambiguous and renamed mappings", () => {
  assert.throws(() => applyReviewedIdentityMigration(baseline, candidate, [pair, pair]), /overlapping/);
  assert.throws(() => applyReviewedIdentityMigration(baseline, candidate, [{ before, after: { ...after, column: 31 } }]), /Stale/);
  assert.throws(() => applyReviewedIdentityMigration(baseline, [...candidate, pass({ ...after, column: 31 })], [pair]), /ambiguous/);
  assert.throws(() => applyReviewedIdentityMigration(baseline, candidate, [{ before, after: { ...after, name: "renamed" } }]), /Invalid/);
  assert.throws(() => applyReviewedIdentityMigration([...baseline, pass(after)], candidate, [pair]), /ambiguous/);
});

test("CA-01 reviewed migration never hides a new failure, skip or unrelated missing identity", () => {
  const missing = { ...before, name: "unrelated missing" };
  const summarize = (rows: unknown[], passCount: number, failCount: number, skips: number) => [...rows,
    ...Object.entries({ tests: rows.length, pass: passCount, fail: failCount, cancelled: 0, skipped: skips, todo: 0 }).map(([key, value]) => ({ type: "test:diagnostic", message: key + " " + value }))];
  const a = summarize([pass(before), pass(missing)], 2, 0, 0);
  const locations = { baseline: { root: "/base", tempRoot: "/tmp" }, candidate: { root: "/candidate", tempRoot: "/tmp" } };
  const error = { message: "new regression" };
  const failed = { ...pass(after), type: "test:fail", error };
  const b = summarize([failed], 0, 1, 0);
  const comparison = compareReports(a, applyReviewedIdentityMigration(a, b, [pair]), locations);
  assert.equal(comparison.differentialPass, false);
  assert.deepEqual(comparison.addedFailures.map((row: { error: unknown }) => row.error), [error]);
  assert.deepEqual(comparison.missingTests, [missing]);
  const skipped = summarize([{ ...pass(after), skip: true }], 0, 0, 1);
  const skippedComparison = compareReports(a, applyReviewedIdentityMigration(a, skipped, [pair]), locations);
  assert.deepEqual(skippedComparison.newSkips, [before]);
  assert.equal(skippedComparison.differentialPass, false);
});
