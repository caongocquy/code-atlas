import path from "node:path";

import { changeGate } from "../../core/gate/change-gate.service.js";
import type { ChangeGateInput, ChangeGateResult } from "../../core/gate/change-gate.types.js";
import { createCliCommandReporter } from "./cli-command-reporter.js";

function valueAfter(args: string[], flag: string): string | undefined { const index = args.indexOf(flag); return index >= 0 ? args[index + 1] : undefined; }
function numberAfter(args: string[], flag: string, max: number, min = 1): number | undefined {
  const value = valueAfter(args, flag); if (value === undefined) return undefined;
  const parsed = Number(value); if (!Number.isInteger(parsed) || parsed < min || parsed > max) throw new Error(`${flag} must be an integer from ${min} to ${max}.`); return parsed;
}
function parse(args: string[]): { repoPath: string; input: ChangeGateInput; json: boolean } {
  const json = args.includes("--json");
  const commit = valueAfter(args, "--commit"); const base = valueAfter(args, "--base"); const head = valueAfter(args, "--head");
  const modes = [args.includes("--staged"), commit !== undefined, base !== undefined || head !== undefined].filter(Boolean).length;
  if (modes > 1) throw new Error("Choose one change source: --staged, --commit, or --base with --head.");
  if (args.includes("--config")) throw new Error("--config is not supported for gate; use repository-root codeatlas.config.json.");
  if (args.includes("--commit") && (!commit || commit.startsWith("--"))) throw new Error("--commit requires a revision.");
  if ((base !== undefined || head !== undefined) && (!base || !head)) throw new Error("--base and --head must be provided together.");
  const valueFlags = new Set(["--commit", "--base", "--head", "--max-depth", "--max-tests", "--max-edges"]);
  const explicitPath = args.find((arg, index) => !arg.startsWith("--") && !valueFlags.has(args[index - 1] ?? ""));
  const common = { maxDepth: numberAfter(args, "--max-depth", 10, 0), maxTests: numberAfter(args, "--max-tests", 1_000), maxEdges: numberAfter(args, "--max-edges", 10_000) };
  const repoPath = path.resolve(explicitPath ?? ".");
  if (args.includes("--staged")) return { repoPath, json, input: { mode: "staged", ...common } };
  if (commit) return { repoPath, json, input: { mode: "commit", commit, ...common } };
  if (base || head) return { repoPath, json, input: { mode: "range", base: base!, head: head!, ...common } };
  return { repoPath, json, input: { mode: "working", ...common } };
}

function format(result: ChangeGateResult): string {
  const lines = ["CodeAtlas Change Gate", "", result.status.toUpperCase()];
  for (const category of ["risk", "tests", "diagnostics", "architecture"] as const) {
    const checks = result.checks.filter((check) => check.category === category); if (!checks.length) continue;
    lines.push("", category[0]!.toUpperCase() + category.slice(1));
    for (const check of checks) lines.push(`  ${check.status === "pass" ? "✓" : check.status === "fail" ? "✗" : check.status === "warn" ? "⚠" : "·"} ${check.message}`);
  }
  if (result.preview) lines.push("", "Target policy preview", `  ${result.preview.status.toUpperCase()}`, "  Current change is evaluated using the baseline Gate policy.");
  lines.push("", "Result", `  ${result.summary.passed} passed · ${result.summary.failed} failed · ${result.summary.warnings} warnings · ${result.summary.skipped} skipped`);
  return lines.join("\n");
}

export async function runGateCommand(args: string[]): Promise<void> {
  const json = args.includes("--json"); const reporter = createCliCommandReporter({ json });
  try {
    const parsed = parse(args); const result = await changeGate(parsed.repoPath, parsed.input);
    if (parsed.json) reporter.output(result); else reporter.success(format(result));
    if (result.status === "fail") process.exitCode = 1;
    else if (result.status === "not_configured") process.exitCode = 2;
  } catch (error) {
    process.exitCode = 2;
    if (json) reporter.output({ error: error instanceof Error ? error.message : String(error) });
    else reporter.failure(`gate failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
