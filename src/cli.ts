#!/usr/bin/env node

import { createCliCommandReporter } from "./adapters/cli/cli-command-reporter.js";
import { formatCommandFailure } from "./adapters/cli/cli-output.js";
import { formatCommandHelp, formatRootHelp, isKnownCommand } from "./adapters/cli/cli-help.js";
import { createRequire } from "node:module";
import path from "node:path";

const [command, ...args] = process.argv.slice(2);
const packageJson = createRequire(import.meta.url)("../package.json") as { version: string };

async function main(): Promise<void> {
  if (command === "--version" || command === "-v") {
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }
  if (command === "--help" || command === "-h" || command === undefined) {
    process.stdout.write(`${formatRootHelp()}\n`);
    return;
  }
  if (args.includes("--help") && command && command !== "--help" && command !== "help" && isKnownCommand(command)) {
    process.stdout.write(`${formatCommandHelp(command)}\n`);
    return;
  }
  if (command === "help" && args[0]) {
    process.stdout.write(`${formatCommandHelp(args[0])}\n`);
    return;
  }
  switch (command) {
    case "mcp": {
      const { runMcpServer } = await import("./adapters/mcp/mcp-server.js");
      await runMcpServer();
      return;
    }
    case "serve": {
      const explicitPath = args.find((arg) => !arg.startsWith("--"));
      if (explicitPath) process.env.CODE_RAG_REPO_PATH = path.resolve(explicitPath);
      await import("./adapters/http/http-server.js");
      return;
    }
    case "integration": {
      const { runIntegrationCommand } = await import("./adapters/cli/integration.command.js");
      await runIntegrationCommand(args);
      return;
    }
    case "connect":
    case "disconnect":
    case "integrations": {
      const { runIntegrationCommand } = await import("./adapters/cli/integration.command.js");
      await runIntegrationCommand([command, ...args]);
      return;
    }
    case "hook": {
      const { runHookCommand } = await import("./adapters/cli/hook.command.js");
      await runHookCommand(args);
      return;
    }
    case "init": {
      const { runInitCommand } = await import("./adapters/cli/init.command.js");
      await runInitCommand(args);
      return;
    }
    case "index":
    case "sync": {
      const { runIndexingCommand } = await import("./adapters/cli/indexing.command.js");
      await runIndexingCommand(command, args);
      return;
    }
    case "status": {
      const { runIndexingCommand } = await import("./adapters/cli/indexing.command.js");
      await runIndexingCommand("status", args);
      return;
    }
    case "inspect-change": {
      const { runInspectChangeCommand } = await import("./adapters/cli/inspect-change.command.js");
      await runInspectChangeCommand(args);
      return;
    }
    case "affected-tests": {
      const { runAffectedTestsCommand } = await import("./adapters/cli/affected-tests.command.js");
      await runAffectedTestsCommand(args);
      return;
    }
    case "explain-incomplete": {
      const { runExplainIncompleteCommand } = await import("./adapters/cli/explain-incomplete.command.js");
      await runExplainIncompleteCommand(args);
      return;
    }
    case "graph-delta": {
      const { runGraphDeltaCommand } = await import("./adapters/cli/graph-delta.command.js");
      await runGraphDeltaCommand(args);
      return;
    }
    case "architecture-drift": {
      const { runArchitectureDriftCommand } = await import("./adapters/cli/architecture-drift.command.js");
      await runArchitectureDriftCommand(args);
      return;
    }
    case "gate": {
      const { runGateCommand } = await import("./adapters/cli/gate.command.js");
      await runGateCommand(args);
      return;
    }
    case "help":
      process.stdout.write(args[0] ? `${formatCommandHelp(args[0])}\n` : `${formatRootHelp()}\n`);
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
