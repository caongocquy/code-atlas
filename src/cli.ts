#!/usr/bin/env node

import { runIntegrationCommand } from "./adapters/cli/integration.command.js";
import { runHookCommand } from "./adapters/cli/hook.command.js";
import { runIndexingCommand } from "./adapters/cli/indexing.command.js";
import { runInitCommand } from "./adapters/cli/init.command.js";
import { runMcpServer } from "./adapters/mcp/mcp-server.js";

const [command, ...args] = process.argv.slice(2);

async function main(): Promise<void> {
  switch (command) {
    case "mcp":
      await runMcpServer();
      return;
    case "integration":
      await runIntegrationCommand(args);
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
        "  init [path] [--agent codex|opencode|claude|all] [--strict]",
        "  index [path] [--skip-git]",
        "  sync [path] [--skip-git] [--quiet]",
        "  status [path]",
        "  integration list|status|install|uninstall <agent> [--scope user|project] [--strict]",
        "  hook install|uninstall|status [--post-commit] [--post-checkout]",
        "  mcp",
        "",
      ].join("\n"));
      return;
    default:
      throw new Error("Unknown command. Run `code-atlas --help`.");
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
