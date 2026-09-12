import path from "node:path";

import { readContextAware, type ContextAwareReadRequest } from "../../core/context/context-aware-read.service.js";
import type { ContextAwareReadResult } from "../../core/context/context.types.js";
import { createCliCommandReporter } from "./cli-command-reporter.js";

function valueAfter(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
}

export function parseContextReadArgs(args: string[]): { repoPath: string; json: boolean; request: ContextAwareReadRequest } {
  const file = valueAfter(args, "--file");
  const sessionId = valueAfter(args, "--session");
  const contextGeneration = valueAfter(args, "--context-generation");
  if (!file) throw new Error("--file requires a repository-relative path.");
  if (!sessionId) throw new Error("--session is required.");
  if (!contextGeneration) throw new Error("--context-generation is required.");
  return { repoPath: path.resolve(args.find((arg, index) => !arg.startsWith("--") && !["--file", "--session", "--context-generation"].includes(args[index - 1] ?? "")) ?? "."), json: args.includes("--json"), request: { sessionId, contextGeneration, subject: { kind: "file", path: file }, projection: "source-v1" } };
}

export function formatContextRead(result: ContextAwareReadResult): string {
  return [`Mode          ${result.mode}`, `Content       ${result.current.contentIdentity}`, ...(result.reason ? [`Reason        ${result.reason}`] : []), ...(result.content !== undefined ? ["", result.content] : []), ...(result.delta ? ["", JSON.stringify(result.delta)] : [])].join("\n");
}

export async function runContextReadCommand(args: string[]): Promise<void> {
  const json = args.includes("--json");
  const reporter = createCliCommandReporter({ command: "context-read", json });
  try { const parsed = parseContextReadArgs(args); const result = await readContextAware(parsed.repoPath, parsed.request); if (json) reporter.output(result); else reporter.success(formatContextRead(result)); }
  catch (error) { process.exitCode = 1; if (json) reporter.output({ error: error instanceof Error ? error.message : String(error) }); else reporter.failure(`context-read failed: ${error instanceof Error ? error.message : String(error)}`); }
}
