import path from "node:path";

import { inspectChange } from "../../core/change/inspect-change.service.js";
import type { InspectChangeInput, InspectChangeResult } from "../../core/change/change.types.js";
import { createCliCommandReporter } from "./cli-command-reporter.js";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function parseInput(args: string[]): { input: InspectChangeInput; repoPath: string; json: boolean } {
  const json = args.includes("--json");
  const modes = [args.includes("--staged"), args.includes("--commit"), args.includes("--base") || args.includes("--head")].filter(Boolean).length;
  if (modes > 1) throw new Error("Choose one change source: --staged, --commit, or --base with --head.");
  const commit = valueAfter(args, "--commit");
  const base = valueAfter(args, "--base");
  const head = valueAfter(args, "--head");
  const explicitPath = args.find((arg, index) => !arg.startsWith("--") && !["--commit", "--base", "--head", "--max-depth"].includes(args[index - 1] ?? ""));
  const repoPath = path.resolve(explicitPath ?? ".");
  if (args.includes("--staged")) return { repoPath, json, input: { mode: "staged", maxDepth: numericDepth(args) } };
  if (args.includes("--commit")) {
    if (!commit) throw new Error("--commit requires a revision.");
    return { repoPath, json, input: { mode: "commit", commit, maxDepth: numericDepth(args) } };
  }
  if (base !== undefined || head !== undefined) {
    if (!base || !head) throw new Error("--base and --head must be provided together.");
    return { repoPath, json, input: { mode: "range", base, head, maxDepth: numericDepth(args) } };
  }
  return { repoPath, json, input: { mode: "working", maxDepth: numericDepth(args) } };
}

function numericDepth(args: string[]): number | undefined {
  const value = valueAfter(args, "--max-depth");
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) throw new Error("--max-depth must be an integer from 0 to 10.");
  return parsed;
}

function formatResult(result: InspectChangeResult): string {
  const lines = [
    "Inspecting changes",
    "",
    `Changed       ${result.summary.changedFiles} files · ${result.summary.changedSymbols} symbols`,
    `Affected      ${result.summary.affectedFiles} files · ${result.summary.affectedSymbols} symbols`,
    `Risk          ${result.risk}`,
  ];
  if (result.mayBeIncomplete) lines.push("", "⚠ Graph/change evidence may be incomplete.");
  for (const reason of result.reasons) lines.push(`  ${reason}`);
  if (result.changedSymbols.length > 0) {
    lines.push("", "Changed symbols");
    for (const symbol of result.changedSymbols.slice(0, 20)) lines.push(`  ${symbol.changeKind} ${symbol.file}:${symbol.startLine ?? "?"} ${symbol.kind} ${symbol.name}`);
  }
  if (result.affectedSymbols.length > 0) {
    lines.push("", "Affected symbols");
    for (const symbol of result.affectedSymbols.slice(0, 20)) lines.push(`  ${symbol.depth}. ${symbol.reason} ${symbol.file}:${symbol.startLine ?? "?"} ${symbol.name}`);
  }
  return lines.join("\n");
}

export async function runInspectChangeCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const reporter = createCliCommandReporter({ command: "inspect-change", json });
  try {
    const parsed = parseInput(args);
    const result = await inspectChange(parsed.repoPath, parsed.input);
    if (parsed.json) reporter.output(result);
    else reporter.success(formatResult(result));
  } catch (error) {
    process.exitCode = 1;
    if (json) reporter.output({ error: error instanceof Error ? error.message : String(error) });
    else reporter.failure(`inspect-change failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
