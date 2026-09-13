import { cliProgressRunner } from "./cli-progress-reporter.js";
import { formatNotice } from "./cli-output.js";
import { getTerminalCapabilities, renderBrandHeader } from "./cli-presentation.js";
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
  | "inspect-change"
  | "integrations"
  | "status"
  | "sync";

const commandSubtitles: Record<CliCommand, string> = {
  "context-compile": "Task context compilation",
  "context-read": "Context-aware read",
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
  "inspect-change": "Change intelligence",
  integrations: "Agent integrations",
  status: "Repository status",
  sync: "Repository indexing",
};

export function createCliCommandReporter(options: { command?: CliCommand; json?: boolean; quiet?: boolean } = {}): CliCommandReporter {
  const json = options.json === true;
  const quiet = options.quiet === true;
  const progress = json || quiet ? silentProgressRunner : cliProgressRunner;
  const capabilities = getTerminalCapabilities();
  if (!json && !quiet && options.command && capabilities.interactive) {
    process.stdout.write(`${renderBrandHeader(commandSubtitles[options.command], capabilities)}\n\n`);
  }
  const humanOutput = (message: string): void => {
    if (!json && !quiet) process.stdout.write(`${message}\n`);
  };

  return {
    json,
    progress,
    start(message) {
      humanOutput(message);
    },
    success(message) {
      humanOutput(message);
    },
    warning(message) {
      if (!json && !quiet) process.stderr.write(`${formatNotice(message, undefined, "warning")}\n`);
    },
    failure(message) {
      if (!json && !quiet) process.stderr.write(`${message}\n`);
    },
    detail(message) {
      if (!json && !quiet) process.stdout.write(`${message}\n`);
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
