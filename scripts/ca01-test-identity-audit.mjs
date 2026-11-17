import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";
import { pathToFileURL } from "node:url";

const outcome = new Set(["test:pass", "test:fail"]);
const semanticKey = id => JSON.stringify([id.file, id.nesting, id.name]);
const locationKey = id => JSON.stringify([id.file, id.line, id.column, id.nesting, id.name]);

export function auditTestIdentityDrift(baseline, candidate) {
  const index = events => {
    const exact = new Map(), semantic = new Map();
    for (const row of events) {
      if (!outcome.has(row.type)) continue;
      const key = locationKey(row.identity);
      if (exact.has(key)) throw new Error("Duplicate test identity: " + key);
      exact.set(key, row);
      const name = semanticKey(row.identity);
      semantic.set(name, [...(semantic.get(name) ?? []), row]);
    }
    return { exact, semantic };
  };
  const a = index(baseline), b = index(candidate);
  const moved = [], removed = [], ambiguous = [], outcomeChanges = [], added = [];
  for (const [key, row] of a.exact) {
    const current = b.exact.get(key);
    const candidates = b.semantic.get(semanticKey(row.identity)) ?? [];
    const origins = a.semantic.get(semanticKey(row.identity)) ?? [];
    if (!current && !candidates.length) { removed.push(row.identity); continue; }
    if (!current && (candidates.length !== 1 || origins.length !== 1)) {
      ambiguous.push({ identity: row.identity, baselineMatches: origins.length, candidateMatches: candidates.length });
      continue;
    }
    const after = current ?? candidates[0];
    if (!current) moved.push({ before: row.identity, after: after.identity });
    if (row.type !== after.type || row.skip !== after.skip || row.todo !== after.todo)
      outcomeChanges.push({ identity: row.identity, before: row.type, after: after.type, moved: !current });
  }
  for (const [key, row] of b.exact) {
    if (!a.exact.has(key) && !(a.semantic.get(semanticKey(row.identity)) ?? []).length) added.push(row.identity);
  }
  return { baselineCount: a.exact.size, candidateCount: b.exact.size, moved, removed, ambiguous, outcomeChanges, added,
    gateDecision: "DIAGNOSTIC_ONLY_NO_WAIVER",
    note: "Frozen full-identity CA-01 comparator remains authoritative; moved tests are not automatically qualified." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [baselinePath, candidatePath, reportPath] = process.argv.slice(2);
  if (![baselinePath, candidatePath, reportPath].every(Boolean)) throw new Error("Usage: ca01-test-identity-audit.mjs baseline.jsonl candidate.jsonl report.json");
  const read = file => readFileSync(file, "utf8").trim().split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
  const report = auditTestIdentityDrift(read(baselinePath), read(candidatePath));
  writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ baseline: report.baselineCount, candidate: report.candidateCount,
    moved: report.moved.length, removed: report.removed.length, ambiguous: report.ambiguous.length,
    outcomeChanges: report.outcomeChanges.length }) + "\n");
  if (report.removed.length || report.ambiguous.length || report.outcomeChanges.length) process.exitCode = 1;
}
