import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

export const GUARDED_METRICS = Object.freeze([
  "hitAt1", "hitAt3", "hitAt5", "mrrAt5", "recallAt5", "recallAt10", "relevantSymbolCoverage",
]);

export function evaluateRetrievalQuality(baseline, candidate) {
  const before = new Map(baseline.parityPayload.map(item => [item.id, item]));
  const after = new Map(candidate.parityPayload.map(item => [item.id, item]));
  assert.equal(before.size, baseline.parityPayload.length, "Duplicate baseline case identity");
  assert.equal(after.size, candidate.parityPayload.length, "Duplicate candidate case identity");
  const regressions = [];
  const improvements = [];
  for (const [id, original] of before) {
    const current = after.get(id);
    if (!current) { regressions.push({ id, reason: "missing_case" }); continue; }
    for (const [profile, stages] of Object.entries(original.profiles)) {
      const latest = current.profiles[profile];
      if (!latest) { regressions.push({ id, profile, reason: "missing_profile" }); continue; }
      for (const stage of ["lexical", "hybrid", "hybridGraphExpansion"]) {
        const a = stages[stage]?.metrics;
        const b = latest[stage]?.metrics;
        if (!a || !b) { regressions.push({ id, profile, stage, reason: "missing_stage_metrics" }); continue; }
        for (const metric of GUARDED_METRICS) {
          if (!Number.isFinite(a[metric]) || !Number.isFinite(b[metric])) {
            regressions.push({ id, profile, stage, metric, reason: "invalid_metric" });
            continue;
          }
          const delta = b[metric] - a[metric];
          if (delta < -1e-12) regressions.push({ id, profile, stage, metric, baseline: a[metric], candidate: b[metric] });
          else if (delta > 1e-12) improvements.push({ id, profile, stage, metric, baseline: a[metric], candidate: b[metric] });
        }
      }
    }
  }
  for (const id of after.keys()) if (!before.has(id)) regressions.push({ id, reason: "added_case_needs_review" });
  return { baseline: baseline.sha256, candidate: candidate.sha256, cases: before.size, regressions, improvements,
    note: "Non-release retrieval-quality diagnostic; matching these metrics does not authorize CA-01 oracle changes or merge." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [baselinePath, candidatePath, outputPath] = process.argv.slice(2);
  if (![baselinePath, candidatePath, outputPath].every(Boolean)) throw new Error("Usage: verify-ca01-retrieval-quality.mjs <baseline.json> <candidate.json> <output.json>");
  const result = evaluateRetrievalQuality(JSON.parse(readFileSync(baselinePath, "utf8")), JSON.parse(readFileSync(candidatePath, "utf8")));
  writeFileSync(outputPath, JSON.stringify(result, null, 2) + "\n");
  console.log(JSON.stringify({ cases: result.cases, regressions: result.regressions.length, improvements: result.improvements.length }));
  if (result.regressions.length) process.exitCode = 1;
}
