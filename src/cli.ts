#!/usr/bin/env node

import { runIntegrationCommand } from "./adapters/cli/integration.command.js";
import { runHookCommand } from "./adapters/cli/hook.command.js";
import { runIndexingCommand } from "./adapters/cli/indexing.command.js";
import { runInitCommand } from "./adapters/cli/init.command.js";
import { runMcpServer } from "./adapters/mcp/mcp-server.js";
import { createCliCommandReporter } from "./adapters/cli/cli-command-reporter.js";
import { formatCommandFailure } from "./adapters/cli/cli-output.js";
import path from "node:path";

const [command, ...args] = process.argv.slice(2);

async function main(): Promise<void> {
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
    case "help":
    case "--help":
    case undefined:
      process.stdout.write([
        "Usage: code-atlas <command>",
        "",
        "  init [path] [--agent codex|opencode|claude|all] [--strict] [--no-guidance]",
        "  index [path] [--skip-git]",
        "  sync [path] [--skip-git] [--quiet]",
        "  status [path]",
        "  connect <agent> [--strict] [--no-guidance]",
        "  disconnect <agent>",
        "  integrations",
        "  integration list|status|install|uninstall <agent> [--scope user|project] [--strict] [--no-guidance] [--json]",
        "  hook install|uninstall|status [--post-commit] [--post-checkout]",
        "  mcp",
        "  serve [path]",
        "",
      ].join("\n"));
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
