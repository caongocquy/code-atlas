import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { selectReviewedSourcePairs } from "../scripts/ca01-reviewed-source-pairs.mjs";
import { applyReviewedIdentityMigration } from "../scripts/ca01-reviewed-identity-migration.mjs";

const identity = { file: "test/example.test.ts", name: "existing test", nesting: 0, line: 1, column: 10 };
const row = (id: typeof identity) => ({ type: "test:pass", identity: id });
const digest = (rows: unknown[]) => createHash("sha256").update(JSON.stringify(rows)).digest("hex");
const baseline = [row(identity)];
const candidate = [row({ ...identity, column: 20 })];
const group = { file: identity.file, identityCount: 1, baselineIdentitySha256: digest([["existing test", 0, 1, 10]]), logicalIdentitySha256: digest([["existing test", 0]]) };

test("reviewed source registry translates only the complete unique logical identity set", () => {
  const pairs = selectReviewedSourcePairs(baseline, candidate, group);
  assert.deepEqual(pairs, [{ before: identity, after: candidate[0]!.identity }]);
  assert.deepEqual(selectReviewedSourcePairs(baseline, baseline, group), []);
  const failure = { ...candidate[0], type: "test:fail", error: { message: "regression" } };
  assert.deepEqual(applyReviewedIdentityMigration(baseline, [failure], pairs), [{ ...failure, identity }]);
  const skip = { ...candidate[0], skip: true };
  assert.deepEqual(applyReviewedIdentityMigration(baseline, [skip], pairs), [{ ...skip, identity }]);
});

test("reviewed source registry rejects missing, extra, duplicate, renamed or altered baseline identities", () => {
  assert.throws(() => selectReviewedSourcePairs(baseline, [], group), /Unreviewed/);
  assert.throws(() => selectReviewedSourcePairs(baseline, [...candidate, row({ ...identity, column: 30 })], group), /Unreviewed/);
  assert.throws(() => selectReviewedSourcePairs(baseline, [row({ ...identity, name: "renamed" })], group), /Unreviewed/);
  assert.throws(() => selectReviewedSourcePairs(candidate, baseline, group), /baseline identity/);
});
