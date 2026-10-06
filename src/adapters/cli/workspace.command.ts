import { queryWorkspaceMap } from "../../core/workspace/workspace-map.service.js";
import type { WorkspaceMapInput } from "../../core/workspace/workspace.types.js";
import { createCliCommandReporter } from "./cli-command-reporter.js";

export async function runWorkspaceCommand(args: string[]): Promise<void> {
  if (args[0] !== "map") throw new Error("Usage: code-atlas workspace map --repo <path> [--repo <path>] | --workspace <config>.");
  const input: WorkspaceMapInput = {};
  for (let i = 1; i < args.length; i++) {
    const flag = args[i];
    if (flag === "--json") continue;
    if (flag === "--full") { input.detail = "full"; continue; }
    if (!["--repo", "--workspace", "--limit"].includes(flag)) throw new Error(`Unknown workspace option: ${flag}`);
    const value = args[++i];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value.`);
    if (flag === "--repo") (input.repositories ??= []).push(value);
    else if (flag === "--workspace") { if (input.workspacePath !== undefined) throw new Error("--workspace may only be selected once."); input.workspacePath = value; }
    else { if (input.limit !== undefined) throw new Error("--limit may only be selected once."); input.limit = Number(value); }
  }
  const result = await queryWorkspaceMap(input);
  const reporter = createCliCommandReporter({ command: "workspace", json: args.includes("--json") });
  if (args.includes("--json")) reporter.output(result);
  else reporter[result.state === "unavailable" ? "failure" : result.state === "partial" ? "warning" : "success"]([`Workspace: ${result.workspace.name ?? "selected repositories"} (${result.state})`,
    ...result.repositories.map(member => `  ${member.displayName}: ${member.health.availability} · ${member.repositoryId} · generation ${member.generationId ?? "unavailable"} · freshness ${member.evidenceState.freshness}${member.health.diagnostics.length ? ` (${member.health.diagnostics.join(", ")})` : ""}`),
    result.consistency].join("\n"));
  if (result.state === "unavailable") process.exitCode = 1;
}
