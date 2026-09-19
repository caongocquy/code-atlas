import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { LANGUAGE_CONFIGS } from "../src/core/graph/parsers/languages.js";
import { execFile as guardedExecFile, installOfflineGuard } from "../eval/context/offline-guard.js";
import { evaluatorPaths, runContextEval } from "../eval/context/run.js";
import { loadCorpus, validateCorpusIntegrity } from "../eval/context/corpus/load-corpus.js";

const root = path.resolve(import.meta.dirname, "..");
const paths = evaluatorPaths(root);

async function readJson(filePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>;
}

function withoutTiming(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutTiming);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>)
    .filter(([key]) => key !== "timingsMs")
    .map(([key, item]) => [key, withoutTiming(item)]));
}

test("acceptance corpus is complete, registry-derived, and internally immutable", async () => {
  const corpus = await loadCorpus(paths);
  const languageIds = LANGUAGE_CONFIGS.map(({ language }) => language);
  const synthetic = new Set(corpus.manifest.cases
    .filter(({ kind }) => kind === "synthetic")
    .map(({ language, syntheticClass }) => `${language}:${syntheticClass}`));

  assert.equal(new Set(languageIds).size, languageIds.length);
  for (const language of languageIds) {
    for (const syntheticClass of ["exact-target", "relationship/change", "incomplete/ambiguity"]) {
      assert.equal(synthetic.has(`${language}:${syntheticClass}`), true, `${language}:${syntheticClass}`);
    }
  }
  assert.deepEqual(
    new Set(corpus.manifest.cases.map(({ caseId }) => caseId)),
    new Set(corpus.baseline.entries.map(({ caseId }) => caseId)),
  );
  assert.equal(corpus.manifest.corpusVersion, "context-eval-v1");
  assert.equal(corpus.baseline.baselineVersion, "context-eval-baseline-v1");
  assert.equal(corpus.policy.policyVersion, "context-eval-policy-v1");
});

test("acceptance rejects missing, orphan, and incompatible baseline data before execution", async () => {
  const corpus = await loadCorpus(paths);
  const baseInput = {
    manifest: corpus.manifest,
    baseline: corpus.baseline,
    policy: corpus.policy,
    manifestPath: corpus.manifestPath,
    baselinePath: corpus.baselinePath,
    policyPath: corpus.policyPath,
  };

  assert.throws(() => validateCorpusIntegrity({
    ...baseInput,
    baseline: { ...corpus.baseline, entries: corpus.baseline.entries.slice(1) },
  }), /missing baseline/);
  assert.throws(() => validateCorpusIntegrity({
    ...baseInput,
    baseline: { ...corpus.baseline, entries: [...corpus.baseline.entries, { ...corpus.baseline.entries[0]!, caseId: "orphan" }] },
  }), /orphan baseline/);
  assert.throws(() => validateCorpusIntegrity({
    ...baseInput,
    baseline: { ...corpus.baseline, corpusVersion: "context-eval-v2" as "context-eval-v1" },
  }), /incompatible.*versions/);
});

test("acceptance keeps the evaluator offline and restores the process boundary", async () => {
  const restore = installOfflineGuard();
  try {
    await assert.rejects(() => fetch("https://example.invalid"), /offline guard/);
    assert.throws(() => guardedExecFile("git", ["remote", "-v"]), /git remote is disabled/);
  } finally {
    restore();
  }
  await assert.doesNotReject(() => fetch("data:text/plain,ok"));
});

test("acceptance preserves controller-owned verification boundaries and CI release wiring", async () => {
  const packageJson = await readJson(path.join(root, "package.json"));
  const scripts = packageJson.scripts as Record<string, string>;
  const workflow = await readFile(path.join(root, ".github/workflows/context-eval.yml"), "utf8");

  assert.match(scripts["eval:context"] ?? "", /runContextEval/);
  assert.match(scripts["eval:context:update-baseline"] ?? "", /updateContextBaseline/);
  assert.match(scripts["eval:context:update-baseline"] ?? "", /process\.argv\.includes\('--write'\)/);
  assert.match(workflow, /CODE_ATLAS_EVAL_OFFLINE:\s*["']?1/);
  assert.match(workflow, /pnpm run eval:context/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(workflow, /continue-on-error\s*:\s*true/);
});

test("acceptance runs two clean evaluations with equal semantic machine reports and unchanged corpus bytes", async () => {
  const before = await Promise.all([readFile(paths.manifestPath), readFile(paths.baselinePath), readFile(paths.policyPath)]);
  const first = await runContextEval({ cwd: root, reportPath: path.join(root, "artifacts/context-eval-report.json") });
  const firstReport = first.report;
  const second = await runContextEval({ cwd: root, reportPath: path.join(root, "artifacts/context-eval-report.json") });
  const secondReport = second.report;
  const after = await Promise.all([readFile(paths.manifestPath), readFile(paths.baselinePath), readFile(paths.policyPath)]);

  assert.equal(first.exitCode, 0, JSON.stringify({ gateDecisions: firstReport.gateDecisions, failures: firstReport.failures }));
  assert.equal(second.exitCode, 0, JSON.stringify({ gateDecisions: secondReport.gateDecisions, failures: secondReport.failures }));
  assert.deepEqual(withoutTiming(firstReport), withoutTiming(secondReport));
  assert.deepEqual(after, before);
});

test("acceptance does not recursively own full-suite or controller verification commands", async () => {
  const source = await readFile(new URL(import.meta.url), "utf8");
  assert.doesNotMatch(source, /npm\s+(?:test|run\s+(?:build|lint))/);
  assert.doesNotMatch(source, /npx\s+tsc\s+--noEmit/);
  assert.doesNotMatch(source, /test\/phase15[abc]-\*\.test\.ts/);
});
