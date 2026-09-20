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
    assert.match(description("compile_task_context"), /bounded.*task evidence/i);
    assert.match(description("inspect_retrieval"), /diagnos/i);
    assert.match(description("index_repository"), /local generated index state/i);
    assert.match(description("sync_repository"), /local generated index state/i);
    assert.match(description("find_callers"), /call.*into/i);
    assert.match(description("find_callees"), /called.*from/i);
    assert.match(description("find_imports"), /imports.*from/i);
    assert.match(description("find_imported_by"), /imports.*target/i);
    assert.match(description("impact"), /structural blast radius.*single relation/i);
    assert.match(description("start_task_context"), /initial evidence/i);
    assert.match(description("trace"), /path between two known/i);
    assert.match(description("list_communities"), /discover/i);
    assert.match(description("get_community"), /expand/i);
    assert.match(description("important_symbols"), /rank/i);
    assert.match(description("architectural_bridges"), /between graph communities/i);
    assert.match(description("find_cycles"), /report.*cycles/i);

    assert.match(property("search_code", "repoPath")?.description ?? "", /local repository/i);
    assert.match(property("search_code", "mode")?.description ?? "", /lexical.*hybrid/i);
    assert.match(property("search_code", "mode")?.description ?? "", /lexical-only/i);
    assert.match(property("search_code", "mode")?.description ?? "", /not_configured/i);
    assert.match(property("inspect_retrieval", "includeSemantic")?.description ?? "", /request.*diagnostics/i);
    assert.match(property("inspect_retrieval", "includeSemantic")?.description ?? "", /no embedding provider.*not_configured/i);
    assert.match(property("inspect_retrieval", "includeReranker")?.description ?? "", /request.*diagnostics/i);
    assert.match(property("inspect_retrieval", "includeReranker")?.description ?? "", /no reranker provider/i);
    for (const name of ["index_repository", "sync_repository"]) {
      const includeSemantic = property(name, "includeSemantic")?.description ?? "";
      assert.match(includeSemantic, /no embedding provider wired/i);
      assert.match(includeSemantic, /not-configured only when no active semantic capability exists/i);
      assert.match(includeSemantic, /active semantic capability.*fail closed/i);
    }
    assert.match(property("inspect_retrieval", "tokenBudget")?.description ?? "", /cap/i);
    assert.match(property("inspect_change", "mode")?.description ?? "", /working.*staged.*commit.*range/i);
    assert.match(property("inspect_change", "commit")?.description ?? "", /commit/i);
    assert.match(property("inspect_change", "base")?.description ?? "", /range/i);
    assert.match(property("index_repository", "skipGit")?.description ?? "", /Git candidate discovery/i);
    assert.match(property("compile_task_context", "detail")?.description ?? "", /compact.*full/i);
    assert.match(property("start_task_context", "detail")?.description ?? "", /compact.*full/i);
    assert.match(property("start_task_context", "anchors")?.description ?? "", /seed/i);
    assert.match(property("refresh_task_context", "detail")?.description ?? "", /compact.*full/i);
    assert.match(property("impact", "maxDepth")?.description ?? "", /bound/i);
    assert.match(property("inspect_change", "maxDepth")?.description ?? "", /bound/i);
    assert.match(property("explain_incomplete", "maxDepth")?.description ?? "", /bound/i);
    assert.match(property("explain_incomplete", "detail")?.description ?? "", /compact.*full/i);
    assert.match(property("explain_incomplete", "scope")?.description ?? "", /repository.*change.*tests/i);
    assert.match(property("explain_incomplete", "mode")?.description ?? "", /working.*staged.*commit.*range/i);
    assert.match(property("explain_incomplete", "commit")?.description ?? "", /required.*commit mode/i);
    assert.match(property("explain_incomplete", "base")?.description ?? "", /required.*range mode.*head/i);
    assert.match(property("explain_incomplete", "head")?.description ?? "", /required.*range mode.*base/i);
    assert.match(property("trace", "maxDepth")?.description ?? "", /bound/i);
    assert.match(property("trace", "mode")?.description ?? "", /directed.*edge direction/i);
    assert.match(property("trace", "mode")?.description ?? "", /explanatory.*inverse edges/i);
    assert.match(description("compile_task_context"), /search_code.*matching-code lookup/i);
    assert.match(description("compile_task_context"), /assemble.*task evidence/i);
  } finally {
    await client.close();
    await server.close();
  }
});
