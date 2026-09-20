import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";

const require = createRequire(import.meta.url);
const root = path.resolve(".");
const cliPath = path.join(root, "src", "cli.ts");
const tsxLoader = require.resolve("tsx/esm");

const expectedTools = [
  "repository_status", "search_code", "get_symbol", "context_read", "compile_task_context",
  "start_task_context", "refresh_task_context", "close_task_context", "find_callers", "find_callees",
  "find_imports", "find_imported_by", "impact", "inspect_change", "affected_tests", "explain_incomplete",
  "graph_delta", "architecture_drift", "change_gate", "trace", "inspect_retrieval", "list_communities",
  "get_community", "important_symbols", "architectural_bridges", "find_cycles", "index_repository", "sync_repository",
] as const;

const expectedAnnotations: Record<string, Record<string, boolean>> = {
  repository_status: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  search_code: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  get_symbol: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  context_read: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  compile_task_context: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  start_task_context: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  refresh_task_context: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  close_task_context: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  find_callers: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  find_callees: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  find_imports: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  find_imported_by: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  impact: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inspect_change: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  affected_tests: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  explain_incomplete: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  graph_delta: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  architecture_drift: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  change_gate: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  trace: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  inspect_retrieval: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  list_communities: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  get_community: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  important_symbols: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  architectural_bridges: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  find_cycles: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  index_repository: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
  sync_repository: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
};

function inspectorCliPath(): string {
  const packagePath = require.resolve("@modelcontextprotocol/inspector/package.json");
  const packageJson = require(packagePath) as { bin: string | Record<string, string> };
  const bin = typeof packageJson.bin === "string" ? packageJson.bin : packageJson.bin["mcp-inspector"];
  assert.ok(bin, "Inspector package must expose the mcp-inspector CLI");
  return path.resolve(path.dirname(packagePath), bin);
}

function runInspector(method: string, options: { homePath: string; toolName?: string; toolArgs?: Record<string, unknown> }) {
  const args = [
    inspectorCliPath(),
    "--cli", process.execPath, "--import", tsxLoader, cliPath, "mcp",
    "--",
    "--method", method,
    "--format", "json",
    ...(options.toolName ? ["--tool-name", options.toolName] : []),
    ...(options.toolArgs ? ["--tool-args-json", JSON.stringify(options.toolArgs)] : []),
  ];
  return spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, HOME: options.homePath, XDG_CONFIG_HOME: path.join(options.homePath, "xdg") },
    timeout: 20_000,
    maxBuffer: 1_000_000,
  });
}

function jsonOutput(result: ReturnType<typeof runInspector>): Record<string, unknown> {
  assert.equal(result.error, undefined, result.stderr);
  assert.equal(result.signal, null, result.stderr);
  assert.ok(result.stdout.trim(), "Inspector must emit JSON output");
  return JSON.parse(result.stdout) as Record<string, unknown>;
}

test("MCP Inspector v2 verifies the actual stdio server contract", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-mcp-inspector-"));
  try {
    const homePath = path.join(repoPath, ".inspector-home");
    await mkdir(path.join(repoPath, "src"), { recursive: true });
    await writeFile(path.join(repoPath, "src", "alpha.ts"), "export function alpha() { return 1; }\n");
    await indexRepository(repoPath, { skipGit: true });

    const initialize = runInspector("initialize", { homePath });
    assert.equal(initialize.status, 0, initialize.stderr);
    assert.ok(jsonOutput(initialize).result, "initialize must succeed");

    const listed = runInspector("tools/list", { homePath });
    assert.equal(listed.status, 0, listed.stderr);
    const tools = (jsonOutput(listed).result as { tools?: Array<Record<string, unknown>> }).tools;
    assert.ok(tools, "tools/list must return tools");
    assert.deepEqual(tools.map((tool) => tool.name).sort(), [...expectedTools].sort());
    for (const tool of tools) {
      assert.equal(typeof tool.description, "string", `${tool.name} needs a description`);
      assert.ok((tool.description as string).length > 0, `${tool.name} needs a description`);
      assert.equal(typeof tool.inputSchema, "object", `${tool.name} needs an input schema`);
      assert.equal(typeof tool.annotations, "object", `${tool.name} needs annotations`);
      assert.deepEqual(tool.annotations, expectedAnnotations[String(tool.name)], `${tool.name} annotations`);
    }
    const getSymbol = tools.find((tool) => tool.name === "get_symbol");
    assert.match(String(getSymbol?.description), /known symbol/i);
    assert.deepEqual(getSymbol?.annotations, {
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
    assert.equal((getSymbol?.inputSchema as { properties?: Record<string, unknown> }).properties?.query !== undefined, true);

    const status = runInspector("tools/call", { homePath, toolName: "repository_status", toolArgs: { repoPath } });
    assert.equal(status.status, 0, status.stderr);
    assert.ok(jsonOutput(status).result, "repository_status must succeed without optional capability initialization");

    const symbol = runInspector("tools/call", { homePath, toolName: "get_symbol", toolArgs: { repoPath, query: "alpha" } });
    assert.equal(symbol.status, 0, symbol.stderr);
    assert.match(JSON.stringify(jsonOutput(symbol)), /alpha/);

    const atlasPath = path.join(repoPath, ".codeatlas", "atlas.db");
    const beforeInvalidCall = await readFile(atlasPath);
    const invalid = runInspector("tools/call", { homePath, toolName: "get_symbol", toolArgs: { repoPath, query: 42 } });
    assert.equal(invalid.status, 5, invalid.stderr);
    assert.match(JSON.stringify(jsonOutput(invalid)), /isError|error|invalid/i);
    assert.deepEqual(await readFile(atlasPath), beforeInvalidCall, "invalid arguments must not mutate the local index");
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
