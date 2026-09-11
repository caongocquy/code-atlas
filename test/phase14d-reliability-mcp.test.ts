import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";

test("MCP keeps initialize stable and exposes the framework reliability slot on graph responses", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14d-mcp-"));
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "phase14d-mcp-test", version: "1" });
  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    assert.ok(tools.tools.some((tool) => tool.name === "repository_status"));
    const status = await client.callTool({ name: "repository_status", arguments: { repoPath } });
    assert.equal(status.isError, undefined);
    const text = status.content.find((item) => item.type === "text");
    assert.ok(text && text.type === "text");
    const value = JSON.parse(text.text) as { framework: { status: string; authoritativeNegativeResults: boolean } };
    assert.equal(value.framework.status, "not_indexed");
    assert.equal(value.framework.authoritativeNegativeResults, false);
  } finally {
    await client.close();
    await server.close();
    await rm(repoPath, { recursive: true, force: true });
  }
});
