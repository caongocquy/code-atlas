#!/usr/bin/env node

import { runMcpServer } from "./adapters/mcp/mcp-server.js";

const command = process.argv[2];

if (command === "mcp") {
  await runMcpServer();
} else {
  process.stderr.write("Usage: code-atlas mcp\n");
  process.exitCode = 1;
}
