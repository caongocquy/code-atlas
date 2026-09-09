#!/usr/bin/env node

import { runIntegrationCommand } from "./adapters/cli/integration.command.js";
import { runHookCommand } from "./adapters/cli/hook.command.js";
import { runIndexingCommand } from "./adapters/cli/indexing.command.js";
import { runInspectChangeCommand } from "./adapters/cli/inspect-change.command.js";
import { runAffectedTestsCommand } from "./adapters/cli/affected-tests.command.js";
import { runExplainIncompleteCommand } from "./adapters/cli/explain-incomplete.command.js";
import { runGraphDeltaCommand } from "./adapters/cli/graph-delta.command.js";
import { runArchitectureDriftCommand } from "./adapters/cli/architecture-drift.command.js";
import { runGateCommand } from "./adapters/cli/gate.command.js";
import { runInitCommand } from "./adapters/cli/init.command.js";
import { runMcpServer } from "./adapters/mcp/mcp-server.js";
import { createCliCommandReporter } from "./adapters/cli/cli-command-reporter.js";
import { formatCommandFailure } from "./adapters/cli/cli-output.js";
import { formatCommandHelp, formatRootHelp, isKnownCommand } from "./adapters/cli/cli-help.js";
import path from "node:path";

const [command, ...args] = process.argv.slice(2);

async function main(): Promise<void> {
  if (args.includes("--help") && command && command !== "--help" && command !== "help" && isKnownCommand(command)) {
    process.stdout.write(`${formatCommandHelp(command)}\n`);
    return;
  }
  if (command === "help" && args[0]) {
    process.stdout.write(`${formatCommandHelp(args[0])}\n`);
    return;
  }
  switch (command) {
    case "mcp":
      await runMcpServer();
      return;
    case "serve": {
      const explicitPath = args.find((arg) => !arg.startsWith("--"));
      if (explicitPath) process.env.CODE_RAG_REPO_PATH = path.resolve(explicitPath);
      await import("./adapters/http/http-server.js");
      return;
    }
    case "integration":
      await runIntegrationCommand(args);
      return;
    case "connect":
    case "disconnect":
    case "integrations":
      await runIntegrationCommand([command, ...args]);
      return;
    case "hook":
      await runHookCommand(args);
      return;
    case "init":
      await runInitCommand(args);
      return;
    case "index":
    case "sync":
      await runIndexingCommand(command, args);
      return;
    case "status":
      await runIndexingCommand("status", args);
      return;
    case "inspect-change":
      await runInspectChangeCommand(args);
      return;
    case "affected-tests":
      await runAffectedTestsCommand(args);
      return;
    case "explain-incomplete":
      await runExplainIncompleteCommand(args);
      return;
    case "graph-delta":
      await runGraphDeltaCommand(args);
      return;
    case "architecture-drift":
      await runArchitectureDriftCommand(args);
      return;
    case "gate":
      await runGateCommand(args);
      return;
    case "help":
    case "--help":
    case undefined:
      process.stdout.write(`${formatRootHelp()}\n`);
      return;
    default:
      throw new Error("Unknown command. Run `code-atlas --help`.");
  }
}

main().catch((error) => {
  const json = process.argv.includes("--json");
  const reporter = createCliCommandReporter({ json });
  if (json) reporter.output({ error: error instanceof Error ? error.message : String(error) });
  else reporter.failure(formatCommandFailure(command ?? "Command", error));
  process.exitCode = 1;
});
