import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";
import { parseContextLifecycleArgs } from "../src/adapters/cli/context-lifecycle.command.js";
import { parseContextCompileArgs } from "../src/adapters/cli/context-compile.command.js";
import { parseContextReadArgs } from "../src/adapters/cli/context-read.command.js";
import { CONTEXT_AWARE_SOURCE_PROJECTION } from "../src/core/context/context-delivery-preparation.js";
import { closeTaskContext, startTaskContext } from "../src/core/context/task-context-lifecycle.service.js";
import { TaskContextLifecycleDomainError } from "../src/core/context/task-context-lifecycle.types.js";
import { TaskContextRepositoryCompilerError, compileTaskContextForRepository } from "../src/core/context/task-context-repository-compiler.js";

async function connectedClient() {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "phase-15c-test-client", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, server };
}

test("CLI lifecycle parsers produce exact start, refresh, and close inputs", () => {
  assert.deepEqual(parseContextLifecycleArgs("start", ["repo", "--task", "Fix auth", "--anchor-file", "src/auth.ts", "--budget-items", "3", "--budget-tokens", "120", "--ttl", "60", "--full", "--json"]), {
    repoPath: path.resolve("repo"),
    json: true,
    input: {
      task: "Fix auth",
      anchors: [{ kind: "file", path: "src/auth.ts" }],
      budget: { maxItems: 3, maxEstimatedTokens: 120 },
      ttlSeconds: 60,
      detail: "full",
    },
  });
  assert.deepEqual(parseContextLifecycleArgs("refresh", ["repo", "handle", "--budget-items", "2", "--full"]), {
    repoPath: path.resolve("repo"),
    json: false,
    input: { taskContextId: "handle", budget: { maxItems: 2 }, detail: "full" },
  });
  assert.deepEqual(parseContextLifecycleArgs("close", ["repo", "handle", "--json"]), {
    repoPath: path.resolve("repo"),
    json: true,
    input: { taskContextId: "handle" },
  });
});

test("existing CLI parsers preserve the shared source projection and compiler input", () => {
  assert.equal(parseContextReadArgs(["repo", "--file", "source.ts", "--session", "s", "--context-generation", "g"]).request.projection, CONTEXT_AWARE_SOURCE_PROJECTION);
  assert.deepEqual(parseContextCompileArgs(["repo", "--task", "Fix auth"]).input, { task: "Fix auth", repoPath: path.resolve("repo"), anchors: [], changedPaths: [], budget: {}, detail: "compact" });
});

test("MCP exposes lifecycle tools with strict refresh and close schemas", async () => {
  const { client, server } = await connectedClient();
  try {
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.filter((tool) => ["start_task_context", "refresh_task_context", "close_task_context"].includes(tool.name)).map((tool) => tool.name).sort(), ["close_task_context", "refresh_task_context", "start_task_context"]);

    const invalidRefresh = await client.callTool({ name: "refresh_task_context", arguments: { taskContextId: "00000000-0000-4000-8000-000000000000", task: "must be rejected" } });
    assert.equal(invalidRefresh.isError, true);
    const invalidClose = await client.callTool({ name: "close_task_context", arguments: { taskContextId: "00000000-0000-4000-8000-000000000000", sessionId: "must be rejected" } });
    assert.equal(invalidClose.isError, true);
  } finally {
    await client.close();
    await server.close();
  }
});

test("MCP maps missing index from lifecycle start to the existing index_required error", async () => {
  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({ name: "start_task_context", arguments: { repoPath: ".", task: "Find source", anchors: [], budget: { maxItems: 1 }, ttlSeconds: 60, detail: "full" } });
    assert.equal(result.isError, true);
    const text = result.content.find((item) => item.type === "text");
    assert.ok(text && text.type === "text");
    assert.equal((JSON.parse(text.text) as { error: { code: string } }).error.code, "index_required");
  } finally {
    await client.close();
    await server.close();
  }
});

test("close maps an invalid UUID to the structured lifecycle error", () => {
  assert.throws(() => closeTaskContext({ taskContextId: "not-a-uuid" }, { repositoryPath: "." }), (error: unknown) => {
    assert.ok(error instanceof TaskContextLifecycleDomainError);
    assert.equal(error.operationError.code, "invalid_task_context_id");
    assert.equal(error.operationError.operation, "close");
    return true;
  });
});

test("MCP preserves structured invalid_task_context_id for close", async () => {
  const { client, server } = await connectedClient();
  try {
    const result = await client.callTool({ name: "close_task_context", arguments: { taskContextId: "not-a-uuid" } });
    assert.equal(result.isError, true);
    const text = result.content.find((item) => item.type === "text");
    assert.ok(text && text.type === "text");
    const value = JSON.parse(text.text) as { error: { code: string } };
    assert.equal(value.error.code, "invalid_task_context_id");
  } finally {
    await client.close();
    await server.close();
  }
});

test("repository compiler types missing indexes and lifecycle maps that boundary error", async () => {
  const missingIndex = new Error("Repository graph is not indexed.");
  await assert.rejects(() => compileTaskContextForRepository(".", { task: "Find source" }, { loadGraph: async () => { throw missingIndex; } }), (error: unknown) => {
    assert.ok(error instanceof TaskContextRepositoryCompilerError);
    assert.equal(error.code, "index_required");
    assert.equal(error.cause, missingIndex);
    return true;
  });
  await assert.rejects(() => startTaskContext({ task: "Find source" }, { repositoryPath: ".", readCurrentChangedPaths: async () => [], compileTaskContextForRepository: async () => { throw new TaskContextRepositoryCompilerError("index_required", missingIndex.message); } }), (error: unknown) => {
    assert.ok(error instanceof TaskContextLifecycleDomainError);
    assert.equal(error.operationError.code, "compiler_validation_failed");
    return true;
  });
});
