import { log } from "@clack/prompts";

import { cliProgressRunner } from "./cli-progress-reporter.js";
import { getTerminalCapabilities, startCliPresentation } from "./cli-presentation.js";
import type { ProgressKind, ProgressReporter, ProgressRunner } from "../../core/progress/progress.types.js";
import { silentProgressRunner } from "../../core/progress/silent-progress-runner.js";

export type CliCommandReporter = {
  readonly json: boolean;
  readonly progress: ProgressRunner;
  start(message: string): void;
  success(message: string): void;
  warning(message: string): void;
  failure(message: string): void;
  detail(message: string): void;
  output(value: unknown): void;
  run<T>(title: string, work: (reporter: ProgressReporter) => T | Promise<T>, kind?: ProgressKind): Promise<T>;
};

export type CliCommand =
  | "context-compile"
  | "context-read"
  | "context-start"
  | "context-refresh"
  | "context-close"
  | "affected-tests"
  | "architecture-drift"
  | "connect"
  | "disconnect"
  | "explain-incomplete"
  | "gate"
  | "graph-delta"
  | "hook"
  | "init"
  | "index"
  | "reindex"
  | "inspect-change"
  | "integrations"
  | "status"
  | "semantic"
  | "sync"
  | "workspace";

const commandSubtitles: Record<CliCommand, string> = {
  "context-compile": "Task context compilation",
  "context-read": "Context-aware read",
  "context-start": "Task context lifecycle",
  "context-refresh": "Task context lifecycle",
  "context-close": "Task context lifecycle",
  "affected-tests": "Affected tests",
  "architecture-drift": "Architecture analysis",
  connect: "Agent integrations",
  disconnect: "Agent integrations",
  "explain-incomplete": "Reliability diagnostics",
  gate: "Change gate",
  "graph-delta": "Graph changes",
  hook: "Agent integration",
  init: "Repository indexing",
  index: "Repository indexing",
  reindex: "Repository indexing",
  "inspect-change": "Change intelligence",
  integrations: "Agent integrations",
  status: "Repository status",
  semantic: "Semantic provider lifecycle",
  sync: "Repository indexing",
  workspace: "Workspace federation",
};

export function createCliCommandReporter(options: { command?: CliCommand; json?: boolean; quiet?: boolean } = {}): CliCommandReporter {
  const json = options.json === true;
  const quiet = options.quiet === true;
  const progress = json || quiet ? silentProgressRunner : cliProgressRunner;
  const capabilities = getTerminalCapabilities();
  if (!json && !quiet && options.command && capabilities.interactive) {
    startCliPresentation(commandSubtitles[options.command], capabilities);
  }
  return {
    json,
    progress,
    start(message) {
      if (!json && !quiet) log.step(message);
    },
    success(message) {
      if (!json && !quiet) log.success(message);
    },
    warning(message) {
      if (!json && !quiet) log.warn(message, { output: process.stderr });
    },
    failure(message) {
      if (!json && !quiet) log.error(message, { output: process.stderr });
    },
    detail(message) {
      if (!json && !quiet) log.message(message);
    },
    output(value) {
      if (json) process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    },
    run<T>(
      title: string,
      work: (reporter: ProgressReporter) => T | Promise<T>,
      kind?: ProgressKind,
    ): Promise<T> {
      return progress.run(title, work, kind);
    },
  };
}
