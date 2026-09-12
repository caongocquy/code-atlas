import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import test from "node:test";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

async function connectedClient() {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "phase-10-test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

async function callJson(client: Client, name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = result.content.find((item) => item.type === "text");
  assert.ok(text && text.type === "text");
  return { result, value: JSON.parse(text.text) as Record<string, unknown> };
}

test("MCP exposes the structured CodeAtlas capability surface", async () => {
  const { client, server } = await connectedClient();
  try {
    const result = await client.listTools();
    const names = result.tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, [
      "architectural_bridges",
      "affected_tests",
      "find_callers",
      "find_callees",
      "find_cycles",
      "find_imported_by",
      "find_imports",
      "explain_incomplete",
      "graph_delta",
      "architecture_drift",
      "change_gate",
      "context_read",
      "get_community",
      "get_symbol",
      "impact",
      "important_symbols",
      "index_repository",
      "inspect_change",
      "inspect_retrieval",
      "list_communities",
      "repository_status",
      "search_code",
      "sync_repository",
      "trace",
    ].sort());
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP repository status does not initialize optional providers", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-10-status-"));
  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({ name: "repository_status", arguments: { repoPath } });
    assert.equal(result.isError, undefined);
    const text = result.content.find((item) => item.type === "text");
    assert.ok(text && text.type === "text");
    const value = JSON.parse(text.text) as { capabilities: { semantic: { state: string }; reranker: { state: string } } };
    assert.equal(value.capabilities.semantic.state, "not_configured");
    assert.equal(value.capabilities.reranker.state, "not_configured");
  } finally {
    await client.close();
    await server.close();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("MCP graph access does not initialize an index while reporting index_required", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-10-readonly-graph-"));
  await writeFile(path.join(repoPath, "source.ts"), "export const source = true;\n");
  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({ name: "get_symbol", arguments: { repoPath, query: "source" } });
    assert.equal(result.isError, true, JSON.stringify(result));
    assert.match((result.content.find((item) => item.type === "text") as { text: string }).text, /error/);
    await assert.rejects(() => access(path.join(repoPath, ".codeatlas", "atlas.db")));
  } finally {
    await client.close();
    await server.close();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("MCP lifecycle, lexical search, graph queries, and Phase 9 tools reuse core services", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-10-"));
  await mkdir(path.join(repoPath, "src"));
  await writeFile(path.join(repoPath, "src", "auth.ts"), "export function AuthService() { return true; }\n");
  await writeFile(path.join(repoPath, "src", "caller.ts"), "import { AuthService } from './auth.js';\nexport function run() { return AuthService(); }\n");

  const { client, server } = await connectedClient();
  try {
    const indexed = await callJson(client, "index_repository", { repoPath, skipGit: true });
    assert.equal(indexed.result.isError, undefined);

    const search = await callJson(client, "search_code", { repoPath, query: "AuthService" });
    assert.equal(search.result.isError, undefined);
    assert.equal((search.value.results as Array<{ file: string }>).some((result) => result.file === "src/auth.ts"), true);

    const symbol = await callJson(client, "get_symbol", { repoPath, query: "AuthService" });
    assert.equal(symbol.value.status, "resolved");
    const callers = await callJson(client, "find_callers", { repoPath, query: "AuthService" });
    assert.equal(callers.value.status, "resolved");
    assert.equal((callers.value.results as Array<{ entity: { name: string } }>).some((item) => item.entity.name === "run"), true);

    const communities = await callJson(client, "list_communities", { repoPath });
    assert.equal((communities.value.totalCommunities as number) > 0, true);
    const important = await callJson(client, "important_symbols", { repoPath, limit: 5 });
    assert.equal(Array.isArray(important.value.items), true);
    const inspection = await callJson(client, "inspect_retrieval", { repoPath, query: "AuthService", graphEnabled: false });
    assert.equal(Array.isArray(inspection.value.lexicalResults), true);
  } finally {
    await client.close();
    await server.close();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("MCP maps a failed index outcome to the existing error wire format", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-10-failed-index-"));
  await mkdir(path.join(repoPath, "src"));
  await writeFile(path.join(repoPath, "src", "source.ts"), "export const value = true;\n");
  const originalWriteCandidateGraph = AtlasStore.prototype.writeCandidateGraph;
  AtlasStore.prototype.writeCandidateGraph = () => {
    throw new Error("injected candidate failure");
  };

  const { client, server } = await connectedClient();
  try {
    const failed = await callJson(client, "index_repository", { repoPath, skipGit: true });
    assert.equal(failed.result.isError, true);
    assert.equal((failed.value.error as { code: string }).code, "index_failed");
  } finally {
    AtlasStore.prototype.writeCandidateGraph = originalWriteCandidateGraph;
    await client.close();
    await server.close();
    await rm(repoPath, { recursive: true, force: true });
  }
});
