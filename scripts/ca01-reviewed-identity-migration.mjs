import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const completed = event => event.type === "test:pass" || event.type === "test:fail";
const identityKey = id => JSON.stringify([id.file, id.line, id.column, id.nesting, id.name]);
const semanticKey = id => JSON.stringify([id.file, id.nesting, id.name]);

// Only reviewed, unique, exact location pairs may be translated. Never change dispositions or errors.
export function applyReviewedIdentityMigration(baseline, candidate, pairs) {
  const index = events => {
    const exact = new Map(), semantic = new Map();
    for (const row of events.filter(completed)) {
      const key = identityKey(row.identity), name = semanticKey(row.identity);
      if (exact.has(key)) throw new Error("Duplicate test identity: " + key);
      exact.set(key, row);
      semantic.set(name, (semantic.get(name) ?? 0) + 1);
    }
    return { exact, semantic };
  };
  const a = index(baseline), b = index(candidate);
  const translations = new Map(), origins = new Set();
  for (const { before, after } of pairs) {
    const from = identityKey(before), to = identityKey(after), name = semanticKey(before);
    if (from === to || name !== semanticKey(after) || origins.has(from) || translations.has(to)) {
      throw new Error("Invalid or overlapping reviewed migration: " + name);
    }
    if (!a.exact.has(from) || !b.exact.has(to) || a.exact.has(to) || b.exact.has(from) ||
        a.semantic.get(name) !== 1 || b.semantic.get(name) !== 1) {
      throw new Error("Stale or ambiguous reviewed migration: " + name);
    }
    origins.add(from);
    translations.set(to, a.exact.get(from).identity);
  }
  return candidate.map(row => {
    const identity = completed(row) ? translations.get(identityKey(row.identity)) : undefined;
    return identity ? { ...row, identity } : row;
  });
}

function git(root, args) {
  return execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
}

function verifySource(root, file, expected) {
  if (git(root, ["rev-parse", `HEAD:${file}`]) !== expected) throw new Error("Reviewed source blob changed: " + file);
  git(root, ["diff", "--quiet", "HEAD", "--", file]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [basePrefix, candidatePrefix, output, baseRoot, candidateRoot, tempRoot, manifestPath] = process.argv.slice(2);
  if (![basePrefix, candidatePrefix, output, baseRoot, candidateRoot, tempRoot, manifestPath].every(Boolean)) throw new Error("Missing reviewed migration diagnostic arguments");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const { baselineRevision, source, pairs } = manifest;
  const reviewedRuntimes = [manifest.runtime, ...manifest.additionalReviewedRuntimes.map(entry => entry.runtime)];
  if (git(baseRoot, ["rev-parse", "HEAD"]) !== baselineRevision) throw new Error("Reviewed baseline revision changed");
  git(candidateRoot, ["merge-base", "--is-ancestor", baselineRevision, "HEAD"]);
  verifySource(baseRoot, source.file, source.baselineBlob);
  verifySource(candidateRoot, source.file, source.candidateBlob);
  if (pairs.some(({ before, after }) => before.file !== source.file || after.file !== source.file)) throw new Error("Migration outside reviewed source file");
  const readProcess = prefix => JSON.parse(readFileSync(prefix + ".process.json", "utf8"));
  const bp = readProcess(basePrefix), cp = readProcess(candidatePrefix);
  const runtime = reviewedRuntimes.find(tuple => ["node", "platform", "arch"].every(key => tuple[key] === cp[key]));
  if (!runtime) throw new Error("Unreviewed candidate runtime");
  for (const p of [bp, cp]) {
    if (p.error || p.signal || ![0, 1].includes(p.exitCode)) throw new Error("Invalid suite process result");
    for (const key of ["node", "platform", "arch"]) if (p[key] !== runtime[key]) throw new Error("Unreviewed runtime: " + key);
  }
  const read = prefix => readFileSync(prefix + ".jsonl", "utf8").trim().split("\n").map(line => JSON.parse(line));
  const baseline = read(basePrefix), candidate = read(candidatePrefix);
  const { compareReports } = await import("./compare-ca01-tests.mjs");
  const locations = { baseline: { root: baseRoot, tempRoot }, candidate: { root: candidateRoot, tempRoot } };
  const raw = compareReports(baseline, candidate, locations);
  const translated = compareReports(baseline, applyReviewedIdentityMigration(baseline, candidate, pairs), locations);
  if ((bp.exitCode === 0) !== raw.strictGreen.baseline || (cp.exitCode === 0) !== raw.strictGreen.candidate) throw new Error("Exit code and test summary disagree");
  writeFileSync(output, JSON.stringify({ releaseAuthorization: false, gateDecision: "DIAGNOSTIC_ONLY_NO_WAIVER", baselineRevision, candidateRevision: git(candidateRoot, ["rev-parse", "HEAD"]), runtime, reviewedPairs: pairs, raw, translated }, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ rawMissing: raw.missingTests.length, translatedMissing: translated.missingTests.length, translatedDifferentialPass: translated.differentialPass, releaseAuthorization: false }) + "\n");
  if (!translated.differentialPass) process.exitCode = 1;
}
