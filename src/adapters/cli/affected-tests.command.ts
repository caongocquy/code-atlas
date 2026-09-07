import path from "node:path";

import { affectedTests } from "../../core/change/affected-tests.service.js";
import type { AffectedTestsInput, AffectedTestsResult } from "../../core/change/test-intelligence.types.js";
import { createCliCommandReporter } from "./cli-command-reporter.js";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function depth(args: string[]): number | undefined {
  const value = valueAfter(args, "--max-depth");
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 10) throw new Error("--max-depth must be an integer from 0 to 10.");
  return parsed;
}

function parse(args: string[]): { repoPath: string; input: AffectedTestsInput; json: boolean } {
  const json = args.includes("--json");
  const commit = valueAfter(args, "--commit");
  const base = valueAfter(args, "--base");
  const head = valueAfter(args, "--head");
  const sourceFlags = [args.includes("--staged"), args.includes("--commit"), base !== undefined || head !== undefined].filter(Boolean).length;
  if (sourceFlags > 1) throw new Error("Choose one change source: --staged, --commit, or --base with --head.");
  const explicitPath = args.find((arg, index) => !arg.startsWith("--") && !["--commit", "--base", "--head", "--max-depth", "--max-tests"].includes(args[index - 1] ?? ""));
  const repoPath = path.resolve(explicitPath ?? ".");
  const maxTestsValue = valueAfter(args, "--max-tests");
  const maxTests = maxTestsValue === undefined ? undefined : Number(maxTestsValue);
  if (maxTests !== undefined && (!Number.isInteger(maxTests) || maxTests < 1 || maxTests > 1_000)) throw new Error("--max-tests must be an integer from 1 to 1000.");
  const common = { maxDepth: depth(args), maxTests };
  if (args.includes("--staged")) return { repoPath, json, input: { mode: "staged", ...common } };
  if (args.includes("--commit")) {
    if (!commit || commit.startsWith("--")) throw new Error("--commit requires a revision.");
    return { repoPath, json, input: { mode: "commit", commit, ...common } };
  }
  if (base !== undefined || head !== undefined) {
    if (!base || !head) throw new Error("--base and --head must be provided together.");
    return { repoPath, json, input: { mode: "range", base, head, ...common } };
  }
  return { repoPath, json, input: { mode: "working", ...common } };
}

function format(result: AffectedTestsResult): string {
  const lines = ["Affected tests", ""];
  for (const item of result.tests.slice(0, 20)) {
    lines.push(`  ✓ ${item.file}`);
    for (const reason of item.reasons.slice(0, 3)) {
      const target = "affectedSymbolId" in reason ? reason.affectedSymbolId : reason.affectedFile;
      lines.push(`    ${reason.kind} → ${target}`);
    }
  }
  if (result.uncoveredAffectedSymbols.length > 0) {
    lines.push("", "Potential test gaps");
    for (const symbol of result.uncoveredAffectedSymbols.slice(0, 20)) lines.push(`  ? ${symbol.file}:${symbol.startLine ?? "?"} ${symbol.name} — no indexed structural test evidence`);
  }
  lines.push("", "Summary", `  ${result.summary.affectedProductionSymbols} affected production symbols`, `  ${result.summary.symbolsWithTestEvidence} with structural test evidence`, `  ${result.summary.uncoveredAffectedSymbols} without indexed test evidence`);
  if (result.mayBeIncomplete) lines.push("", "⚠ Graph/test evidence may be incomplete.");
  return lines.join("\n");
}

export async function runAffectedTestsCommand(args: string[]): Promise<void> {
  try {
    const parsed = parse(args);
    const reporter = createCliCommandReporter({ json: parsed.json });
    const result = await affectedTests(parsed.repoPath, parsed.input);
    if (parsed.json) reporter.output(result);
    else reporter.success(format(result));
  } catch (error) {
    process.exitCode = 1;
    const json = args.includes("--json");
    const reporter = createCliCommandReporter({ json });
    if (json) reporter.output({ error: error instanceof Error ? error.message : String(error) });
    else reporter.failure(`affected-tests failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
