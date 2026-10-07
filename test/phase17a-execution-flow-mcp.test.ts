import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";
import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { loadIndexedGraphReadOnly } from "../src/core/graph/indexed-graph.service.js";

async function indexedFixture() {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase17a-flow-"));
  await mkdir(path.join(repoPath, "src"), { recursive: true });
  await writeFile(path.join(repoPath, "src", "flow.c"), [
    "int repository() { return 1; }",
    "int service() { return repository(); }",
    "int handler() { return service(); }",
  ].join("\n"));
  const indexed = await indexRepository(repoPath, { skipGit: true });
  assert.equal(indexed.kind, "published", JSON.stringify(indexed));
  const loaded = await loadIndexedGraphReadOnly(repoPath);
  assert.ok(loaded.graph.edges.some((edge) => edge.type === "calls"), JSON.stringify({ nodes: loaded.graph.nodes, edges: loaded.graph.edges }));
  return repoPath;
}

function payload(result: { structuredContent?: unknown }): Record<string, unknown> {
  assert.ok(result.structuredContent && typeof result.structuredContent === "object");
  return result.structuredContent as Record<string, unknown>;
}

test("execution_flow MCP preserves compact/full execution structure and trace behavior", async () => {
  const repoPath = await indexedFixture();
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "phase17a-execution-flow-client", version: "1.0.0" });

  try {
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const toolNames = new Set((await client.listTools()).tools.map((tool) => tool.name));
    assert.ok(toolNames.has("execution_flow"));

    const args = { repoPath, entry: "handler", detail: "compact", maxDepth: 5, maxNodes: 20 };
    const compact = payload(await client.callTool({ name: "execution_flow", arguments: args }));
    const full = payload(await client.callTool({ name: "execution_flow", arguments: { ...args, detail: "full" } }));
    assert.equal(compact.status, "resolved");
    assert.equal(full.status, "resolved");
    const view = (value: Record<string, unknown>) => ({
      nodeNames: (value.nodes as Array<{ subject: { kind: string; node?: { name: string } } }>).map((node) => node.subject.kind === "language" ? node.subject.node?.name : "route"),
      edgeKinds: (value.edges as Array<{ kind: string }>).map((edge) => edge.kind),
    });
    assert.deepEqual(view(compact), view(full));
    assert.deepEqual(view(compact).nodeNames, ["handler", "service", "repository"]);
    assert.deepEqual(view(compact).edgeKinds, ["call", "call"]);

    const trace = payload(await client.callTool({ name: "trace", arguments: {
      repoPath, from: "handler", to: "repository", maxDepth: 5,
    } }));
    assert.equal(trace.status, "found");
  } finally {
    await client.close();
    await server.close();
    await rm(repoPath, { recursive: true, force: true });
  }
});
