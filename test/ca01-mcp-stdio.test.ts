import assert from "node:assert/strict";
import test from "node:test";
import { rm } from "node:fs/promises";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { createWorkload } from "../eval/mcp/benchmark.js";

test("CA-01 built MCP stdio returns complete budgeted JSON and validates controls", async () => {
  const repoPath = await createWorkload(process.cwd());
  const client = new Client({ name: "ca01-stdio-smoke", version: "1" });
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve("dist/cli.js"), "mcp"], stderr: "pipe" });
  let childStderr = "";
  transport.stderr?.on("data", (chunk: Buffer | string) => { childStderr += String(chunk); });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    assert.ok(tools.tools.find(tool => tool.name === "search_code")!.inputSchema.properties!.response);
    const result = await client.callTool({ name: "search_code", arguments: { repoPath, query: "largeEvidence", limit: 80, response: { mode: "focused", maxOutputBytes: 8_000 } } });
    assert.equal(result.isError, undefined);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 8_000);
    assert.deepEqual(JSON.parse((result.content as Array<{ text: string }>)[0].text), result.structuredContent);
    const value = result.structuredContent as { output: { nextCursor: string; truncated: boolean }; results: unknown[] };
    assert.equal(value.output.truncated, true);
    assert.ok(value.output.nextCursor);
    assert.ok(value.results.length > 0);
    const invalid = await client.callTool({ name: "search_code", arguments: { repoPath, query: "largeEvidence", response: { mode: "invalid" } } });
    assert.equal(invalid.isError, true);
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    throw new Error(`${detail}\nChild stderr:\n${childStderr || "(empty)"}`, { cause: error });
  } finally {
    await client.close(); await transport.close(); await rm(repoPath, { recursive: true, force: true });
  }
});
