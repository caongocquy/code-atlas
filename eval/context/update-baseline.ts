import { updateBaselineFromCorpus } from "./runner/update-baseline.js";
import type { EvalRunnerDeps } from "./run.js";
import type { GoldenBaseline } from "./types.js";

export async function updateContextBaseline(args: { cwd: string; write: boolean }, deps: EvalRunnerDeps = {}): Promise<{ candidate: GoldenBaseline; diff: string; wrote: boolean }> {
  return updateBaselineFromCorpus(args, deps);
}
