import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { hasUsableFailureEvidence } from "./ca01-test-reporter.mjs";

function normalize(error, { root, tempRoot }) {
  const identities = new Map();
  const rootForms = [...new Set([root, root.replaceAll("\\", "/"), root.replaceAll("/", "\\")])].sort((a, b) => b.length - a.length);
  const tempForms = [...new Set([tempRoot, tempRoot.replaceAll("\\", "/"), tempRoot.replaceAll("/", "\\")])];
  const visit = value => {
    if (Array.isArray(value)) return value.map(visit);
    if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map(key => [key, visit(value[key])]));
    if (typeof value !== "string") return value;
    const replaceRoot = (text, form, replacement) => text.replaceAll(form, (match, offset, whole) => {
      const next = whole[offset + match.length];
      return next === undefined || /[\\/\s):"']/.test(next) ? replacement : match;
    });
    for (const form of rootForms) value = replaceRoot(value, form, "<checkout>");
    for (const form of tempForms) value = replaceRoot(value, form, "<tmp>");
    // Only Node mkdtemp's six-character suffix on a path under the recorded OS temp root.
    value = value.replace(/(<tmp>[\\/][^\s"'<>\\/]+)-[A-Za-z0-9]{6}(?=[\\/\s"')]|$)/g, "$1-<temp>");
    return value.replace(/\b[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b/gi, id => {
      if (!identities.has(id)) identities.set(id, `<uuid-${identities.size}>`);
      return identities.get(id);
    });
  };
  return visit(error);
}

export function compareReports(baseline, candidate, locations) {
  const read = events => {
    const tests = new Map(), summary = {};
    for (const event of events) {
      if (event.type === "test:diagnostic") {
        const match = /^(tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(event.message);
        if (match) {
          if (match[1] in summary) throw new Error(`Duplicate suite summary: ${match[1]}`);
          summary[match[1]] = Number(match[2]);
        }
      } else if (event.type === "test:pass" || event.type === "test:fail") {
        if (!event.identity?.file || !event.identity.name) throw new Error("Missing test identity");
        const key = JSON.stringify(event.identity);
        if (tests.has(key)) throw new Error(`Duplicate test identity: ${key}`);
        if (event.type === "test:fail" && !hasUsableFailureEvidence(event.error)) throw new Error(`Missing usable error evidence: ${key}`);
        const validFlag = value => typeof value === "boolean" || (typeof value === "string" && value.trim().length > 0);
        if (!validFlag(event.skip) || !validFlag(event.todo) || (event.skip && (event.todo || event.type !== "test:pass"))) throw new Error(`Invalid test disposition: ${key}`);
        tests.set(key, event);
      }
    }
    if (!["tests", "pass", "fail", "cancelled", "skipped", "todo"].every(key => Number.isInteger(summary[key]))) throw new Error("Incomplete suite summary");
    // Cancellation never qualifies for a differential gate; reject before counting completed outcomes.
    if (summary.cancelled !== 0) throw new Error("Cancelled suite cannot qualify: incomplete summary of completed outcomes");
    const counts = { tests: tests.size, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
    for (const event of tests.values()) {
      const outcome = event.skip ? "skipped" : event.todo ? "todo" : event.type === "test:pass" ? "pass" : "fail";
      counts[outcome]++;
    }
    if (Object.keys(counts).some(key => counts[key] !== summary[key])) throw new Error("Suite records do not match summary");
    return { tests, summary };
  };
  const a = read(baseline), b = read(candidate);
  const addedFailures = [], changedFailures = [], newSkips = [], changedSkips = [], newTodos = [], missingTests = [], removedFailures = [], equivalentFailures = [];
  for (const [key, after] of b.tests) {
    const before = a.tests.get(key);
    if (after.skip && !before?.skip) newSkips.push(after.identity);
    if (after.skip && before?.skip && !isDeepStrictEqual(after.skip, before.skip)) changedSkips.push(after.identity);
    if (after.todo && !before?.todo) newTodos.push(after.identity);
    if (after.type === "test:fail") {
      if (before?.type !== "test:fail") addedFailures.push(after);
      else if (!isDeepStrictEqual(normalize(before.error, locations.baseline), normalize(after.error, locations.candidate))) changedFailures.push({ identity: after.identity, baseline: before.error, candidate: after.error });
      else equivalentFailures.push(after.identity);
    }
  }
  for (const [key, before] of a.tests) {
    const after = b.tests.get(key);
    if (!after) missingTests.push(before.identity);
    if (before.type === "test:fail" && after?.type !== "test:fail") removedFailures.push(before.identity);
  }
  const differentialPass = !addedFailures.length && !changedFailures.length && !newSkips.length && !changedSkips.length && !newTodos.length && !missingTests.length && !b.summary.cancelled && !a.summary.cancelled;
  return { strictGreen: { baseline: a.summary.fail === 0 && a.summary.cancelled === 0, candidate: b.summary.fail === 0 && b.summary.cancelled === 0 },
    differentialPass, baseline: a.summary, candidate: b.summary, addedFailures, changedFailures, equivalentFailures, removedFailures, newSkips, changedSkips, newTodos, missingTests,
    normalization: ["explicit checkout roots", "recorded OS temp roots and six-character mkdtemp path suffixes", "UUID bijection within each error preserving identity equality"],
    releasePolicy: "NO-GO pending explicit baseline-debt approval and required qualification. Differential PASS is not release authorization." };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [basePrefix, candidatePrefix, output, baseRoot, candidateRoot, tempRoot] = process.argv.slice(2);
  if (![basePrefix, candidatePrefix, output, baseRoot, candidateRoot, tempRoot].every(Boolean)) throw new Error("Usage: compare-ca01-tests.mjs <baseline-prefix> <candidate-prefix> <output.json> <baseline-root> <candidate-root> <os-temp-root>");
  const events = prefix => readFileSync(`${prefix}.jsonl`, "utf8").trim().split("\n").map(line => JSON.parse(line));
  const bp = JSON.parse(readFileSync(`${basePrefix}.process.json`, "utf8")), cp = JSON.parse(readFileSync(`${candidatePrefix}.process.json`, "utf8"));
  if (bp.error || cp.error || bp.signal || cp.signal || ![0, 1].includes(bp.exitCode) || ![0, 1].includes(cp.exitCode)) throw new Error("Invalid suite process result");
  for (const key of ["node", "platform", "arch"]) if (bp[key] !== cp[key]) throw new Error(`Incomparable runtime ${key}`);
  const result = compareReports(events(basePrefix), events(candidatePrefix), { baseline: { root: baseRoot, tempRoot }, candidate: { root: candidateRoot, tempRoot } });
  if ((bp.exitCode === 0) !== result.strictGreen.baseline || (cp.exitCode === 0) !== result.strictGreen.candidate) throw new Error("Exit code and test summary disagree");
  writeFileSync(output, JSON.stringify({ ...result, runtime: { node: cp.node, platform: cp.platform, arch: cp.arch } }, null, 2) + "\n");
  process.stdout.write(JSON.stringify({ strictGreen: result.strictGreen, differentialPass: result.differentialPass,
    equivalentFailures: result.equivalentFailures.length, added: result.addedFailures.length, changed: result.changedFailures.length, newSkips: result.newSkips.length, missingTests: result.missingTests.length }) + "\n");
  if (!result.differentialPass) process.exitCode = 1;
}
