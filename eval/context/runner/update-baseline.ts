import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";

import { installOfflineGuard } from "../offline-guard.js";
import { loadCorpus, type LoadedCorpus } from "../corpus/load-corpus.js";
import { evaluateLoadedCorpus, evaluatorPaths, type EvalRunnerDeps } from "../run.js";
import { resolveQualityBudget } from "./aggregate.js";
import type { BaselineEntry, GoldenBaseline, GateFailure } from "../types.js";

function isCorrectnessFailure(failure: GateFailure): boolean {
  return ["correctness", "determinism", "reconstruction", "authority", "uncertainty", "isolation", "lifecycle"].some((prefix) => failure.gate === prefix || failure.gate.startsWith(`${prefix}.`));
}

function candidateBaseline(corpus: LoadedCorpus, scores: Awaited<ReturnType<typeof evaluateLoadedCorpus>>["scores"]): GoldenBaseline {
  const scoreById = new Map(scores.map((score) => [score.caseId, score]));
  return {
    corpusVersion: corpus.baseline.corpusVersion,
    baselineVersion: corpus.baseline.baselineVersion,
    policyVersion: corpus.baseline.policyVersion,
    entries: corpus.manifest.cases.map((evalCase) => {
      const score = scoreById.get(evalCase.caseId);
      if (!score) throw new Error(`Baseline update missing observed case ${evalCase.caseId}`);
      const previous = corpus.baseline.entries.find(({ caseId }) => caseId === evalCase.caseId);
      if (!previous) throw new Error(`Baseline update missing existing baseline case ${evalCase.caseId}`);
      const entry: BaselineEntry = {
        caseId: evalCase.caseId,
        selectedItems: score.metrics.selectedItems,
        estimatedTokens: score.metrics.estimatedTokens,
        returnedBytes: score.metrics.returnedBytes,
        requiredHitRate: score.metrics.requiredHitRate,
        supportingHitRate: score.metrics.supportingHitRate,
        ...(previous.qualityOverrides ? { qualityOverrides: structuredClone(previous.qualityOverrides) } : {}),
      };
      resolveQualityBudget(corpus.policy, entry);
      return entry;
    }),
  };
}

function diffBaseline(oldBaseline: GoldenBaseline, candidate: GoldenBaseline, oldBytes: Uint8Array): string {
  const oldById = new Map(oldBaseline.entries.map((entry) => [entry.caseId, entry]));
  const lines = [`baseline sha256: ${createHash("sha256").update(oldBytes).digest("hex")}`];
  for (const entry of candidate.entries) {
    const old = oldById.get(entry.caseId);
    if (!old) continue;
    for (const field of ["selectedItems", "estimatedTokens", "returnedBytes", "requiredHitRate", "supportingHitRate"] as const) {
      if (old[field] !== entry[field]) lines.push(`${entry.caseId}.${field}: ${String(old[field])} -> ${String(entry[field])}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export async function updateBaselineFromCorpus(args: { cwd: string; write: boolean }, deps: EvalRunnerDeps = {}): Promise<{ candidate: GoldenBaseline; diff: string; wrote: boolean }> {
  const restoreOfflineGuard = installOfflineGuard();
  try {
    const paths = evaluatorPaths(args.cwd);
    const corpus = await (deps.loadCorpus ?? loadCorpus)(paths);
    const oldBytes = await readFile(corpus.baselinePath);
    const result = await evaluateLoadedCorpus(corpus, args.cwd, deps);
    const failures = [...result.scores.flatMap(({ failures }) => failures), ...result.aggregate.failures];
    const correctnessFailures = failures.filter(isCorrectnessFailure);
    if (correctnessFailures.length > 0) {
      throw new Error(`Baseline update refused: correctness gates failed (${correctnessFailures.map(({ gate }) => gate).join(", ")})`);
    }
    const candidate = candidateBaseline(corpus, result.scores);
    const diff = diffBaseline(corpus.baseline, candidate, oldBytes);
    if (!args.write) return { candidate, diff, wrote: false };
    await writeFile(corpus.baselinePath, `${JSON.stringify(candidate, null, 2)}\n`, "utf8");
    return { candidate, diff, wrote: true };
  } finally {
    restoreOfflineGuard();
  }
}

export { candidateBaseline, diffBaseline };
