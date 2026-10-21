import assert from "node:assert/strict";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { Buffer } from "node:buffer";

const consumer = process.argv[2], output = process.argv[3];
if (!consumer || !output) throw new Error("Usage: ca01-packed-mcp-smoke.mjs <consumer-directory> <output.json>");
const packagePath = path.resolve(consumer, "node_modules/@showdar2112/code-atlas/package.json");
const require = createRequire(packagePath);
const { Client } = require("@modelcontextprotocol/sdk/client/index.js");
const { StdioClientTransport } = require("@modelcontextprotocol/sdk/client/stdio.js");
const fixture = await mkdtemp(path.join(os.tmpdir(), "ca01-packed-"));
await writeFile(path.join(fixture, "source.ts"), Array.from({ length: 30 }, (_, i) => `export function boundedEvidence${i}() { return "${"shared evidence ".repeat(30)}"; }`).join("\n"));
const client = new Client({ name: "ca01-packed-gate", version: "1" });
const transport = new StdioClientTransport({ command: process.execPath, args: [path.resolve(consumer, "node_modules/@showdar2112/code-atlas/dist/cli.js"), "mcp"], stderr: "pipe" });
let stderr = "";
transport.stderr?.on("data", chunk => { stderr += chunk.toString(); });
const evidence = { node: process.version, platform: process.platform, arch: process.arch, version: require(packagePath).version, modes: [] };
try {
  await client.connect(transport);
  assert.ok((await client.listTools()).tools.some(tool => tool.name === "search_code"));
  const indexed = await client.callTool({ name: "index_repository", arguments: { repoPath: fixture, skipGit: true } });
  assert.ok(!indexed.isError);
  const args = { repoPath: fixture, query: "boundedEvidence", mode: "lexical", limit: 80 };
  const legacy = await client.callTool({ name: "search_code", arguments: args });
  assert.ok(!legacy.isError);
  const baseline = JSON.parse(legacy.content[0].text); assert.deepEqual(baseline, legacy.structuredContent);
  const ids = baseline.results.map(item => item.documentId); assert.equal(ids.length, 30);
  for (const mode of ["compact", "focused", "full"]) {
    const observed = [], sizes = []; let cursor;
    do {
      assert.ok(sizes.length < 60, "Pagination must terminate");
      const result = await client.callTool({ name: "search_code", arguments: { ...args, response: { mode, maxOutputBytes: 8000, pageSize: 10, ...(cursor ? { cursor } : {}) } } });
      assert.ok(!result.isError, JSON.stringify(result));
      const value = JSON.parse(result.content[0].text); assert.deepEqual(value, result.structuredContent);
      const bytes = Buffer.byteLength(JSON.stringify(result)); assert.ok(bytes <= 8000);
      sizes.push(bytes); observed.push(...value.results.map(item => item.documentId)); cursor = value.output.nextCursor;
    } while (cursor);
    assert.deepEqual(observed, ids); assert.equal(new Set(observed).size, ids.length);
    evidence.modes.push({ mode, pages: sizes.length, bytes: sizes, items: observed.length, completeJson: true, legacyIdentityAndOrder: true });
  }
  const invalid = await client.callTool({ name: "search_code", arguments: { ...args, response: { mode: "focused", maxOutputBytes: 64 } } });
  assert.equal(invalid.isError, true);
  await writeFile(output, JSON.stringify({ ...evidence, status: "PASS", invalidBudgetRejected: true }, null, 2) + "\n");
} catch (error) {
  await writeFile(output, JSON.stringify({ ...evidence, status: "FAIL", error: String(error), stderr }, null, 2) + "\n");
  throw error;
} finally { await client.close(); await transport.close(); await rm(fixture, { recursive: true, force: true }); }
