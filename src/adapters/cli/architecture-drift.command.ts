import path from "node:path";

import { architectureDrift } from "../../core/architecture/architecture-drift.service.js";
import type { ArchitectureDriftInput, ArchitectureDriftResult } from "../../core/architecture/architecture-drift.types.js";
import { createCliCommandReporter } from "./cli-command-reporter.js";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function parse(args: string[]): { repoPath: string; input: ArchitectureDriftInput; json: boolean } {
  const json = args.includes("--json");
  const commit = valueAfter(args, "--commit");
  const base = valueAfter(args, "--base");
  const head = valueAfter(args, "--head");
  const configPath = valueAfter(args, "--config");
  const maxEdgesValue = valueAfter(args, "--max-edges");
  if (args.includes("--config") && (!configPath || configPath.startsWith("--"))) throw new Error("--config requires a path.");
  if (args.includes("--max-edges") && maxEdgesValue === undefined) throw new Error("--max-edges requires a value.");
  if (args.includes("--commit") && commit === undefined) throw new Error("--commit requires a revision.");
  const modes = [args.includes("--staged"), commit !== undefined, base !== undefined || head !== undefined].filter(Boolean).length;
  if (modes > 1) throw new Error("Choose one change source: --staged, --commit, or --base with --head.");
  const maxEdges = maxEdgesValue === undefined ? undefined : Number(maxEdgesValue);
  if (maxEdges !== undefined && (!Number.isInteger(maxEdges) || maxEdges < 1 || maxEdges > 10_000)) throw new Error("--max-edges must be an integer from 1 to 10000.");
  if (commit !== undefined && (!commit || commit.startsWith("--"))) throw new Error("--commit requires a revision.");
  if ((base !== undefined || head !== undefined) && (!base || !head)) throw new Error("--base and --head must be provided together.");
  const valueFlags = new Set(["--commit", "--base", "--head", "--max-edges", "--config"]);
  const explicitPath = args.find((arg, index) => !arg.startsWith("--") && !valueFlags.has(args[index - 1] ?? ""));
  const repoPath = path.resolve(explicitPath ?? ".");
  const common = { maxEdges, ...(configPath === undefined ? {} : { configPath }) };
  if (args.includes("--staged")) return { repoPath, json, input: { mode: "staged", ...common } };
  if (commit !== undefined) return { repoPath, json, input: { mode: "commit", commit, ...common } };
  if (base !== undefined || head !== undefined) return { repoPath, json, input: { mode: "range", base: base!, head: head!, ...common } };
  return { repoPath, json, input: { mode: "working", ...common } };
}

function reference(value: NonNullable<ArchitectureDriftResult["introduced"][number]["from"]>): string {
  return "symbolId" in value ? `${value.file}:${value.qualifiedName ?? value.name}` : value.file;
}

function format(result: ArchitectureDriftResult): string {
  const lines = ["Architecture drift", "", "Introduced"];
  for (const finding of result.introduced.slice(0, 20)) {
    lines.push(`  ${finding.severity.toUpperCase()} ${finding.ruleId ?? finding.kind}`, `        ${finding.message}`, `        Cause: ${finding.cause.replaceAll("_", " ")}`);
    if (finding.from && finding.to) lines.push(`        ${reference(finding.from)} → ${reference(finding.to)}`);
    const cycle = finding.evidence.find((item) => item.kind === "cycle_path");
    if (cycle?.kind === "cycle_path") lines.push(`        ${cycle.path.join(" → ")}`);
  }
  lines.push("", "Resolved");
  for (const finding of result.resolved.slice(0, 20)) lines.push(`  ✓ ${finding.ruleId ?? finding.kind}  ${finding.message}`);
  lines.push("", "Summary", `  ${result.summary.introduced} introduced`, `  ${result.summary.resolved} resolved`, `  ${result.summary.high} high · ${result.summary.medium} medium · ${result.summary.low} low`);
  if (result.mayBeIncomplete) {
    lines.push("", "⚠ Structural evidence is incomplete.", "  Absence of additional architecture drift is not authoritative.");
    for (const reason of result.reasons.slice(0, 5)) lines.push(`  ${reason}`);
  }
  return lines.join("\n");
}

export async function runArchitectureDriftCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const reporter = createCliCommandReporter({ json });
  try {
    const parsed = parse(args);
    const result = await architectureDrift(parsed.repoPath, parsed.input);
    if (parsed.json) reporter.output(result);
    else reporter.success(format(result));
  } catch (error) {
    process.exitCode = 1;
    if (json) reporter.output({ error: error instanceof Error ? error.message : String(error) });
    else reporter.failure(`architecture-drift failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
