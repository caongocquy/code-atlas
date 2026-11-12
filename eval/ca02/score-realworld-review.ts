import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

type Candidate = { to: string; targetFile: string };
type Review = {
  id: string;
  review: {
    status: "pending" | "resolved" | "unresolved" | "external" | "ambiguous";
    expectedTargets: Candidate[] | null;
    reviewer: string | null;
    notes: string | null;
  };
  predictedTargets: Candidate[];
};

export type Adjudication = { status: "review_required"; counts: { total: number; reviewed: number; pending: number }; metrics: null }
  | { status: "adjudicated"; counts: { total: number; reviewed: number; excluded: number }; metrics: {
    tp: number; fp: number; fn: number; precision: number | null; recall: number | null;
  } };

function targetKey(value: Candidate): string {
  return JSON.stringify([value.targetFile, value.to]);
}

/** Count only exact symbol-target and file matches on independently reviewed callsites. */
export function scoreAdjudicatedSites(sites: Review[]): Adjudication {
  const ids = new Set<string>();
  let reviewed = 0;
  for (const site of sites) {
    assert.ok(site.id && !ids.has(site.id), "Each review item needs a unique ID");
    ids.add(site.id);
    assert.ok(Array.isArray(site.predictedTargets), "Predicted targets are required");
    if (site.review.status === "pending") continue;
    assert.ok(site.review.reviewer?.trim(), "Reviewed callsite requires a named reviewer");
    assert.ok(site.review.notes?.trim(), "Reviewed callsite requires source-backed justification");
    if (site.review.status === "resolved") {
      assert.ok(site.review.expectedTargets?.length, "Resolved callsite requires expected targets");
    } else {
      assert.deepEqual(site.review.expectedTargets, [], "Non-resolved callsite must not claim a target");
    }
    reviewed++;
  }
  if (reviewed !== sites.length) {
    return { status: "review_required", counts: { total: sites.length, reviewed, pending: sites.length - reviewed }, metrics: null };
  }
  let tp = 0, fp = 0, fn = 0, excluded = 0;
  for (const site of sites) {
    if (site.review.status === "external" || site.review.status === "ambiguous") { excluded++; continue; }
    const expected = new Set((site.review.expectedTargets ?? []).map(targetKey));
    const predicted = new Set(site.predictedTargets.map(targetKey));
    for (const key of predicted) if (expected.has(key)) tp++; else fp++;
    for (const key of expected) if (!predicted.has(key)) fn++;
  }
  return {
    status: "adjudicated",
    counts: { total: sites.length, reviewed, excluded },
    metrics: { tp, fp, fn,
      precision: tp + fp > 0 ? tp / (tp + fp) : null,
      recall: tp + fn > 0 ? tp / (tp + fn) : null },
  };
}

if (process.argv[1] && /score-realworld-review\.(?:ts|js)$/.test(process.argv[1])) {
  const inputIndex = process.argv.indexOf("--input");
  const outputIndex = process.argv.indexOf("--output");
  assert.ok(inputIndex > -1 && outputIndex > -1, "Usage: --input packet.json --output score.json");
  const packet = JSON.parse(await readFile(process.argv[inputIndex + 1]!, "utf8"));
  assert.equal(packet.schemaVersion, "ca02-realworld-review-v1");
  const scored = scoreAdjudicatedSites(packet.sites);
  const result = { ...scored, selection: packet.selection ?? { method: "full_census", populationCallsites: packet.sites.length } };
  await writeFile(path.resolve(process.argv[outputIndex + 1]!), JSON.stringify(result, null, 2) + "\n");
  process.stdout.write("CA02_REALWORLD_SCORE " + JSON.stringify(result) + "\n");
}
