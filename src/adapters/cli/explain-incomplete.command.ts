import path from "node:path";

import { explainIncomplete } from "../../core/diagnostics/explain-incomplete.service.js";
import type { ExplainIncompleteInput, ExplainIncompleteResult } from "../../core/diagnostics/explain-incomplete.service.js";
import { createCliCommandReporter } from "./cli-command-reporter.js";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function maxDepth(args: string[]): number | undefined {
  const value = valueAfter(args, "--max-depth");
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) throw new Error("--max-depth must be an integer from 0 to 10.");
  return parsed;
}

function repoPath(args: string[]): string {
  return path.resolve(args.find((arg, index) => !arg.startsWith("--") && !["--commit", "--base", "--head", "--max-depth"].includes(args[index - 1] ?? "")) ?? ".");
}

function parse(args: string[]): { repoPath: string; input: ExplainIncompleteInput; json: boolean } {
  const json = args.includes("--json");
  const tests = args.includes("--tests");
  const change = args.includes("--change");
  const commit = valueAfter(args, "--commit");
  const base = valueAfter(args, "--base");
  const head = valueAfter(args, "--head");
  const source = args.includes("--staged") || commit !== undefined || base !== undefined || head !== undefined;
  if (tests && change) throw new Error("Choose one scope: --change or --tests.");
  if (!tests && (change || source) || tests) {
    const mode = args.includes("--staged") ? "staged" : commit !== undefined ? "commit" : base !== undefined || head !== undefined ? "range" : "working";
    if (mode === "commit" && (!commit || commit.startsWith("--"))) throw new Error("--commit requires a revision.");
    if (mode === "range" && (!base || !head)) throw new Error("--base and --head must be provided together.");
    return {
      repoPath: repoPath(args),
      json,
      input: { scope: tests ? "tests" : "change", mode, ...(mode === "commit" ? { commit } : {}), ...(mode === "range" ? { base, head } : {}), maxDepth: maxDepth(args) },
    };
  }
  return { repoPath: repoPath(args), json, input: { scope: "repository" } };
}

function format(result: ExplainIncompleteResult): string {
  const lines = ["Coverage diagnostics", "", result.mayBeIncomplete ? "Graph evidence is incomplete." : "No known coverage limitation affects negative results."];
  if (result.gaps.length > 0) {
    lines.push("", "Gaps");
    for (const gap of result.gaps.slice(0, 20)) lines.push(`  ${gap.count} ${gap.kind}${gap.files?.length ? ` · ${gap.files.slice(0, 3).join(", ")}` : ""}`);
  }
  lines.push("", result.authoritativeNegativeResults ? "Negative results are authoritative within indexed evidence." : "Negative results are not authoritative.");
  if (result.metrics.length > 0) {
    lines.push("", "Metrics");
    for (const metric of result.metrics) lines.push(`  ${metric.name} ${metric.resolved} / ${metric.total} (${Math.round(metric.ratio * 100)}%)`);
  }
  if (result.verificationTargets.length > 0) {
    lines.push("", "Verify");
    for (const target of result.verificationTargets.slice(0, 20)) lines.push(`  ${target.file}${target.symbolId ? ` · ${target.symbolId}` : ""} — ${target.reason}`);
  }
  return lines.join("\n");
}

export async function runExplainIncompleteCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const reporter = createCliCommandReporter({ json });
  try {
    const parsed = parse(args);
    const result = await explainIncomplete(parsed.repoPath, parsed.input);
    if (parsed.json) reporter.output(result);
    else reporter.success(format(result));
  } catch (error) {
    process.exitCode = 1;
    if (json) reporter.output({ error: error instanceof Error ? error.message : String(error) });
    else reporter.failure(`explain-incomplete failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
