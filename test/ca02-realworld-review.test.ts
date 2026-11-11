import assert from "node:assert/strict";
import test from "node:test";
import { scoreAdjudicatedSites } from "../eval/ca02/score-realworld-review.js";

const target = (to: string) => ({ to, targetFile: "src/index.ts" });
const reviewed = (id: string, status: "resolved" | "unresolved" | "external" | "ambiguous", expectedTargets: ReturnType<typeof target>[], predictedTargets: ReturnType<typeof target>[]) => ({
  id, predictedTargets,
  review: { status, expectedTargets, reviewer: "Independent Reviewer", notes: "Checked source and symbol ownership" },
});

test("CA-02 cannot report accuracy from unreviewed real-world predictions", () => {
  const unreviewed = [{
    id: "pending", predictedTargets: [target("known")],
    review: { status: "pending" as const, expectedTargets: null, reviewer: null, notes: null },
  }];
  const result = scoreAdjudicatedSites(unreviewed);
  assert.equal(result.status, "review_required");
  assert.equal(result.metrics, null);
});

test("CA-02 scores TP, FP and FN by full file-qualified targets", () => {
  const result = scoreAdjudicatedSites([
    reviewed("one", "resolved", [target("correct"), target("missing")], [target("correct"), target("wrong")]),
    reviewed("two", "unresolved", [], [target("wrong")]),
    reviewed("three", "external", [], [target("external")]),
  ]);
  assert.equal(result.status, "adjudicated");
  if (result.status !== "adjudicated") return;
  assert.deepEqual(result.metrics, { tp: 1, fp: 2, fn: 1, precision: 1 / 3, recall: 1 / 2 });
  assert.equal(result.counts.excluded, 1);
});

test("CA-02 refuses duplicate and unsupported/incomplete adjudications", () => {
  const good = reviewed("dup", "resolved", [target("ok")], [target("ok")]);
  assert.throws(() => scoreAdjudicatedSites([good, good]), /unique ID/);
  assert.throws(() => scoreAdjudicatedSites([{
    ...good, review: { ...good.review, reviewer: "" },
  }]), /named reviewer/);
  assert.throws(() => scoreAdjudicatedSites([{
    ...good, review: { ...good.review, status: "resolved" as const, expectedTargets: [] },
  }]), /expected targets/);
});
