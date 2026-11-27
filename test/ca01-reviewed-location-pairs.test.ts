import assert from "node:assert/strict";
import test from "node:test";
import { locationPairDigest, selectReviewedLocationPairs } from "../scripts/ca01-reviewed-location-pairs.mjs";

const before = { file: "test/example.test.ts", name: "existing test", nesting: 0, line: 1, column: 10 };
const pair = { before, after: { ...before, column: 20 } };
const other = { before: { ...before, name: "another test" }, after: { ...before, name: "another test", column: 30 } };
const source = { file: before.file, pairCount: 2, pairSha256: locationPairDigest([pair, other]) };

test("reviewed identity digests bind exact locations independently of event order", () => {
  assert.deepEqual(selectReviewedLocationPairs({ moved: [other, pair] }, [source]), [other, pair]);
  assert.throws(() => selectReviewedLocationPairs({ moved: [pair] }, [source]), /Unreviewed/);
  assert.throws(() => selectReviewedLocationPairs({ moved: [pair, { ...other, after: { ...other.after, column: 31 } }] }, [source]), /Unreviewed/);
  assert.throws(() => selectReviewedLocationPairs({ moved: [pair, other] }, [source, source]), /duplicate/);
});

test("reviewed identity digests never translate an unrelated source or renamed test", () => {
  const extra = { before: { ...before, file: "test/unreviewed.test.ts" }, after: { ...pair.after, file: "test/unreviewed.test.ts" } };
  assert.deepEqual(selectReviewedLocationPairs({ moved: [pair, other, extra] }, [source]), [pair, other]);
  assert.throws(() => locationPairDigest([{ before, after: { ...pair.after, name: "replacement" } }]), /Invalid/);
});
