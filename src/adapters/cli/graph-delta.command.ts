import path from "node:path";

import { graphDelta } from "../../core/change/graph-delta.service.js";
import type { GraphDeltaInput, GraphDeltaResult } from "../../core/change/graph-delta.types.js";
import { createCliCommandReporter } from "./cli-command-reporter.js";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

function parse(args: string[]): { repoPath: string; input: GraphDeltaInput; json: boolean } {
  const json = args.includes("--json");
  const commit = valueAfter(args, "--commit");
  const base = valueAfter(args, "--base");
  const head = valueAfter(args, "--head");
  const modes = [args.includes("--staged"), commit !== undefined, base !== undefined || head !== undefined].filter(Boolean).length;
  if (modes > 1) throw new Error("Choose one change source: --staged, --commit, or --base with --head.");
  const maxEdgesValue = valueAfter(args, "--max-edges");
  const maxEdges = maxEdgesValue === undefined ? undefined : Number(maxEdgesValue);
  if (maxEdges !== undefined && (!Number.isInteger(maxEdges) || maxEdges < 1 || maxEdges > 10_000)) throw new Error("--max-edges must be an integer from 1 to 10000.");
  const explicitPath = args.find((arg, index) => !arg.startsWith("--") && !["--commit", "--base", "--head", "--max-edges"].includes(args[index - 1] ?? ""));
  const repoPath = path.resolve(explicitPath ?? ".");
  if (args.includes("--staged")) return { repoPath, json, input: { mode: "staged", maxEdges } };
  if (commit !== undefined) {
    if (!commit || commit.startsWith("--")) throw new Error("--commit requires a revision.");
    return { repoPath, json, input: { mode: "commit", commit, maxEdges } };
  }
  if (base !== undefined || head !== undefined) {
    if (!base || !head) throw new Error("--base and --head must be provided together.");
    return { repoPath, json, input: { mode: "range", base, head, maxEdges } };
  }
  return { repoPath, json, input: { mode: "working", maxEdges } };
}

function format(result: GraphDeltaResult): string {
  const lines = ["Structural graph delta", "", `Changed files  ${result.summary.changedFiles}`, "", "Added relationships"];
  for (const edge of result.addedEdges.slice(0, 20)) lines.push(`  ${label(edge)}  ${edge.kind}`);
  lines.push("", "Removed relationships");
  for (const edge of result.removedEdges.slice(0, 20)) lines.push(`  ${label(edge)}  ${edge.kind}`);
  lines.push("", "Summary", `  ${result.summary.addedEdges} added`, `  ${result.summary.removedEdges} removed`);
  if (result.mayBeIncomplete) {
    lines.push("", "⚠ Structural evidence may be incomplete.");
    for (const reason of result.reasons.slice(0, 5)) lines.push(`  ${reason}`);
  }
  return lines.join("\n");
}

function label(edge: GraphDeltaResult["addedEdges"][number]): string {
  const name = (reference: typeof edge.from) => "symbolId" in reference ? `${reference.file}:${reference.qualifiedName ?? reference.name}` : reference.file;
  return `${name(edge.from)} → ${name(edge.to)}`;
}

export async function runGraphDeltaCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const reporter = createCliCommandReporter({ command: "graph-delta", json });
  try {
    const parsed = parse(args);
    const result = await graphDelta(parsed.repoPath, parsed.input);
    if (parsed.json) reporter.output(result);
    else reporter.success(format(result));
  } catch (error) {
    process.exitCode = 1;
    if (json) reporter.output({ error: error instanceof Error ? error.message : String(error) });
    else reporter.failure(`graph-delta failed: ${error instanceof Error ? error.message : String(error)}`);
  }
}
