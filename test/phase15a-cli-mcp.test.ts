import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { parseContextReadArgs } from "../src/adapters/cli/context-read.command.js";
import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";

test("context-read CLI requires explicit session, generation, and file selector", () => {
  assert.deepEqual(parseContextReadArgs(["repo", "--file", "src/a.ts", "--session", "s", "--context-generation", "g", "--json"]), { repoPath: path.resolve("repo"), json: true, request: { sessionId: "s", contextGeneration: "g", subject: { kind: "file", path: "src/a.ts" }, projection: "source-v1" } });
  assert.throws(() => parseContextReadArgs(["repo", "--file", "src/a.ts"]), /session|generation/i);
});

test("MCP exposes context-aware reads as one explicit opt-in tool", async () => {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "phase15a-test", version: "1" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try { assert.ok((await client.listTools()).tools.some((tool) => tool.name === "context_read")); }
  finally { await client.close(); await server.close(); }
});
