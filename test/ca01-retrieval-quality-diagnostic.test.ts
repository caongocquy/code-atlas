import assert from "node:assert/strict";
import test from "node:test";

import { evaluateRetrievalQuality, GUARDED_METRICS } from "../scripts/verify-ca01-retrieval-quality.mjs";

const profile = (metrics) => ({
  lexical: { metrics }, hybrid: { metrics }, hybridGraphExpansion: { metrics },
});
const allMetrics = (recall = 0.75) => Object.fromEntries(GUARDED_METRICS.map(key => [key, key === "recallAt10" ? recall : 1]));
const report = (metrics) => ({ sha256: "example", parityPayload: [{ id: "sample", profiles: { enabled: profile(metrics) } }] });

test("CA-01 diagnostic accepts unchanged or improved retrieval quality without requiring matching fingerprints", () => {
  const baseline = report(allMetrics());
  const candidate = report(allMetrics(1));
  candidate.sha256 = "different-but-allowed";
  const result = evaluateRetrievalQuality(baseline, candidate);
  assert.equal(result.regressions.length, 0);
  assert.equal(result.improvements.length, 3);
  assert.ok(result.improvements.every(item => item.metric === "recallAt10"));
});

test("CA-01 diagnostic catches a loss of relevant recall even when case identity remains stable", () => {
  const result = evaluateRetrievalQuality(report(allMetrics(1)), report(allMetrics(0.5)));
  assert.equal(result.regressions.length, 3);
  assert.ok(result.regressions.every(item => item.metric === "recallAt10"));
});

test("CA-01 diagnostic rejects missing cases and profiles instead of silently skipping them", () => {
  const baseline = report(allMetrics());
  const candidate = report(allMetrics());
  candidate.parityPayload = [];
  assert.deepEqual(evaluateRetrievalQuality(baseline, candidate).regressions.map(x => x.reason), ["missing_case"]);
  const missingProfile = report(allMetrics());
  missingProfile.parityPayload[0].profiles = {};
  assert.deepEqual(evaluateRetrievalQuality(baseline, missingProfile).regressions.map(x => x.reason), ["missing_profile"]);
});
