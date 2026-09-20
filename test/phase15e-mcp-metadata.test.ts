import assert from "node:assert/strict";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";

async function connectedClient() {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "phase-15e-metadata-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

const expectedAnnotations = {
  repository_status: [false, true, false, false],
  search_code: [false, true, false, false],
  get_symbol: [true, false, true, false],
  context_read: [false, true, false, false],
  compile_task_context: [false, true, false, false],
  start_task_context: [false, true, false, false],
  refresh_task_context: [false, true, false, false],
  close_task_context: [false, true, true, false],
  find_callers: [true, false, true, false],
  find_callees: [true, false, true, false],
  find_imports: [true, false, true, false],
  find_imported_by: [true, false, true, false],
  impact: [true, false, true, false],
  inspect_change: [true, false, true, false],
  affected_tests: [true, false, true, false],
  explain_incomplete: [true, false, true, false],
  graph_delta: [true, false, true, false],
  architecture_drift: [true, false, true, false],
  change_gate: [true, false, true, false],
  trace: [true, false, true, false],
  inspect_retrieval: [false, true, false, false],
  list_communities: [true, false, true, false],
  get_community: [true, false, true, false],
  important_symbols: [true, false, true, false],
  architectural_bridges: [true, false, true, false],
  find_cycles: [true, false, true, false],
  index_repository: [false, true, false, false],
  sync_repository: [false, true, false, false],
} as const;

test("MCP tools/list exposes truthful local safety annotations", async () => {
  const { client, server } = await connectedClient();
  try {
    const result = await client.listTools();
    assert.equal(result.tools.length, 28);
    const tools = new Map(result.tools.map((tool) => [tool.name, tool]));
    assert.deepEqual([...tools.keys()].sort(), Object.keys(expectedAnnotations).sort());

    for (const [name, [readOnlyHint, destructiveHint, idempotentHint, openWorldHint]] of Object.entries(expectedAnnotations)) {
      assert.deepEqual(tools.get(name)?.annotations, {
        readOnlyHint,
        destructiveHint,
        idempotentHint,
        openWorldHint,
      }, name);
    }
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP tools/list distinguishes adjacent tools and guides material inputs", async () => {
  const { client, server } = await connectedClient();
  try {
    const tools = new Map((await client.listTools()).tools.map((tool) => [tool.name, tool]));
    const description = (name: string) => tools.get(name)?.description ?? "";
    const property = (name: string, field: string) => (
      tools.get(name)?.inputSchema.properties?.[field] as { description?: string } | undefined
    );

    assert.match(description("search_code"), /matching code/i);
    assert.match(description("get_symbol"), /known symbol/i);
    assert.match(description("context_read"), /selected file or range/i);
    assert.match(description("compile_task_context"), /bounded evidence/i);
    assert.match(description("inspect_retrieval"), /diagnos/i);
    assert.match(description("index_repository"), /local generated index state/i);
    assert.match(description("sync_repository"), /local generated index state/i);

    assert.match(property("search_code", "repoPath")?.description ?? "", /local repository/i);
    assert.match(property("search_code", "mode")?.description ?? "", /lexical.*hybrid/i);
    assert.match(property("inspect_retrieval", "tokenBudget")?.description ?? "", /cap/i);
    assert.match(property("inspect_change", "mode")?.description ?? "", /working.*staged.*commit.*range/i);
    assert.match(property("inspect_change", "commit")?.description ?? "", /commit/i);
    assert.match(property("inspect_change", "base")?.description ?? "", /range/i);
    assert.match(property("index_repository", "skipGit")?.description ?? "", /Git candidate discovery/i);
  } finally {
    await client.close();
    await server.close();
  }
});
