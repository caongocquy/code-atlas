import { readFile } from "node:fs/promises";
import path from "node:path";

import { installOfflineGuard } from "./offline-guard.js";
import { loadCorpus, validateCorpusWorkspaceRefs, type CorpusPaths, type LoadedCorpus } from "./corpus/load-corpus.js";
import { materializeWorkspace } from "./corpus/materialize-workspace.js";
import { executeCase, executeLifecycleScenario } from "./runner/execute-case.js";
import { aggregateScores } from "./runner/aggregate.js";
import { buildMachineReport, writeReport } from "./runner/report.js";
import { scoreCase, scoreLifecycle } from "./runner/score-case.js";
import {
  CORPUS_VERSION,
  BASELINE_VERSION,
  POLICY_VERSION,
  type AggregateScore,
  type CaseScore,
  type EvalCase,
  type GateFailure,
  type MachineReport,
} from "./types.js";
import { indexRepository } from "../../src/core/indexing/index-pipeline.service.js";

export type EvalRunnerDeps = {
  loadCorpus?: typeof loadCorpus;
  executeCase?: typeof executeCase;
  executeLifecycleScenario?: typeof executeLifecycleScenario;
  materializeWorkspace?: typeof materializeWorkspace;
  indexRepository?: typeof indexRepository;
};

const zeroMetrics = {
  selectedItems: 0,
  estimatedTokens: 0,
  returnedBytes: 0,
  requiredHitRate: 0,
  supportingHitRate: 0,
  contextPrecision: 0,
  fullItems: 0,
  deltaItems: 0,
  unchangedItems: 0,
  rehydratedItems: 0,
  requestedBytes: 0,
  savedBytes: 0,
  reuseRate: 0,
  bodyResendCount: 0,
  timingsMs: { indexLoad: 0, compile: 0, lifecycleStart: 0, refresh: 0 },
} as const;

function executionFailure(evalCase: EvalCase, error: unknown): GateFailure {
  return {
    gate: "isolation.execution",
    scope: "case",
    caseId: evalCase.caseId,
    observed: error instanceof Error ? error.message : String(error),
    expected: "case executes successfully",
    message: "Evaluator execution failed before the case could be scored",
  };
}

function failedCase(evalCase: EvalCase, failure: GateFailure): CaseScore {
  return {
    caseId: evalCase.caseId,
    metrics: { ...zeroMetrics },
    failures: [failure],
    gates: {
      correctness: false,
      determinism: false,
      reconstruction: false,
      authorityUncertainty: false,
      isolation: false,
      catastrophicQuality: false,
    },
  };
}

async function lifecycleFailures(
  evalCase: EvalCase,
  fixtureRoot: string,
  deps: EvalRunnerDeps,
): Promise<readonly GateFailure[]> {
  const lifecycle = evalCase.lifecycle;
  if (!lifecycle) return [];
  const materialize = deps.materializeWorkspace ?? materializeWorkspace;
  const index = deps.indexRepository ?? indexRepository;
  const execute = deps.executeLifecycleScenario ?? executeLifecycleScenario;
  const run = async (): Promise<readonly GateFailure[]> => {
    const workspace = await materialize({ case: evalCase, fixtureRoot });
    try {
      if (workspace.git) await index(workspace.root);
      else await index(workspace.root, { skipGit: true });
      const observed = await execute({ evalCase, root: workspace.root });
      return scoreLifecycle(observed, lifecycle);
    } finally {
      await workspace.cleanup();
    }
  };
  return [...await run(), ...await run()];
}

function pathsFor(cwd: string): CorpusPaths {
  const root = path.resolve(cwd, "eval/context");
  return {
    manifestPath: path.join(root, "corpus/manifest.json"),
    baselinePath: path.join(root, "baselines/context-eval-v1.json"),
    policyPath: path.join(root, "baselines/context-eval-policy-v1.json"),
  };
}

function fixturePath(cwd: string, evalCase: EvalCase): string {
  return path.resolve(cwd, "eval/context/corpus", evalCase.workspaceRef);
}

function withLifecycleScore(score: CaseScore, failures: readonly GateFailure[]): CaseScore {
  if (failures.length === 0) return { ...score, gates: { ...score.gates, isolation: true } };
  return {
    ...score,
    failures: [...score.failures, ...failures],
    gates: { ...score.gates, isolation: false },
  };
}

export async function evaluateLoadedCorpus(corpus: LoadedCorpus, cwd: string, deps: EvalRunnerDeps = {}): Promise<{ scores: readonly CaseScore[]; aggregate: AggregateScore }> {
  const execute = deps.executeCase ?? executeCase;
  const scores: CaseScore[] = [];
  for (const evalCase of corpus.manifest.cases) {
    const fixtureRoot = fixturePath(cwd, evalCase);
    try {
      const first = await execute({ evalCase, fixtureRoot });
      const repeat = await execute({ evalCase, fixtureRoot });
      const score = scoreCase({ evalCase, first, repeat, baseline: corpus.baseline.entries.find(({ caseId }) => caseId === evalCase.caseId) });
      const lifecycle = await lifecycleFailures(evalCase, fixtureRoot, deps);
      scores.push(withLifecycleScore(score, lifecycle));
    } catch (error) {
      scores.push(failedCase(evalCase, executionFailure(evalCase, error)));
    }
  }
  const baselines = new Map(corpus.baseline.entries.map((entry) => [entry.caseId, entry]));
  return { scores, aggregate: aggregateScores(scores, baselines, corpus.policy) };
}

function fallbackReport(error: unknown): MachineReport {
  const failure: GateFailure = {
    gate: "integrity.load",
    scope: "integrity",
    observed: error instanceof Error ? error.message : String(error),
    expected: "valid corpus, baseline, and policy",
    message: "Evaluator inputs could not be loaded or validated",
  };
  return buildMachineReport({
    corpusVersion: CORPUS_VERSION,
    baselineVersion: BASELINE_VERSION,
    baselineSha256: "",
    policyVersion: POLICY_VERSION,
    policySha256: "",
    cases: [],
    aggregate: { metrics: { ...zeroMetrics }, failures: [failure], aggregateQuality: false },
  });
}

export async function runContextEval(args: { cwd: string; reportPath: string }, deps: EvalRunnerDeps = {}): Promise<{ report: MachineReport; exitCode: 0 | 1 }> {
  const restoreOfflineGuard = installOfflineGuard();
  try {
    let report: MachineReport;
    try {
      const corpus = await (deps.loadCorpus ?? loadCorpus)(pathsFor(args.cwd));
      validateCorpusWorkspaceRefs({ manifest: corpus.manifest, corpusRoot: path.dirname(corpus.manifestPath) });
      const result = await evaluateLoadedCorpus(corpus, args.cwd, deps);
      const [baselineBytes, policyBytes] = await Promise.all([readFile(corpus.baselinePath), readFile(corpus.policyPath)]);
      report = buildMachineReport({
        corpusVersion: corpus.manifest.corpusVersion,
        baselineVersion: corpus.baseline.baselineVersion,
        policyVersion: corpus.policy.policyVersion,
        baselineSha256: corpus.baselineSha256,
        policySha256: corpus.policySha256,
        baselineBytes,
        policyBytes,
        cases: result.scores,
        aggregate: result.aggregate,
      });
    } catch (error) {
      report = fallbackReport(error);
    }
    await writeReport(args.reportPath, report);
    return { report, exitCode: Object.values(report.gateDecisions).every(Boolean) ? 0 : 1 };
  } finally {
    restoreOfflineGuard();
  }
}

export function evaluatorPaths(cwd: string): CorpusPaths {
  return pathsFor(cwd);
}
