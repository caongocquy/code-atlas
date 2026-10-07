import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";
import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";

const tsxLoader = createRequire(import.meta.url).resolve("tsx/esm");
const cli = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
function run(args: string[], cwd: string) {
  return spawnSync(process.execPath, ["--import", tsxLoader, cli, "workspace", "map", ...args, "--json"], { cwd, encoding: "utf8", timeout: 20000 });
}
test("workspace_map tools/list and real MCP calls preserve explicit membership, read-only metadata and partial results", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase17d-a-mcp-"));
  const repo = path.join(root, "api"); await mkdir(repo); await writeFile(path.join(repo, "source.ts"), "export function source() {}\n");
  await indexRepository(repo, { skipGit: true });
  const server = createMcpServer(); const client = new Client({ name: "workspace-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(st), client.connect(ct)]);
  try {
    const tools = (await client.listTools()).tools;
    const tool = tools.find(tool => tool.name === "workspace_map"); assert.ok(tool);
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal(tools.some(tool => ["workspace_links"].includes(tool.name)), false);
    for (const args of [{}, { repositories: [repo], workspacePath: "x" }]) {
      assert.equal((await client.callTool({ name: "workspace_map", arguments: args })).isError, true);
    }
    const compact = await client.callTool({ name: "workspace_map", arguments: { repositories: [repo] } });
    assert.equal(compact.structuredContent?.truncated, false);
    assert.deepEqual(compact.structuredContent?.details, []);
    const args = { repositories: [repo, path.join(root, "missing")], detail: "full" };
    const result = await client.callTool({ name: "workspace_map", arguments: args }); assert.equal(result.isError, undefined);
    assert.equal(result.structuredContent?.state, "partial");
    assert.deepEqual((await client.callTool({ name: "workspace_map", arguments: args })).structuredContent, result.structuredContent);
  } finally { await client.close(); await server.close(); await rm(root, { recursive: true, force: true }); }
});
test("workspace CLI repeated repos/config use the core contract and invalid/all-unavailable requests have nonzero exits", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase17d-a-cli-"));
  const repo = path.join(root, "api"); await mkdir(repo); await writeFile(path.join(repo, "source.ts"), "export function source() {}\n");
  await indexRepository(repo, { skipGit: true });
  try {
    const good = run(["--repo", repo, "--repo", path.join(root, "missing")], process.cwd());
    assert.equal(good.status, 0, good.stderr); assert.equal(JSON.parse(good.stdout).state, "partial");
    const relative = run(["--repo", "api", "--full"], root);
    assert.equal(relative.status, 0, relative.stderr); assert.equal(JSON.parse(relative.stdout).details.length, 1);
    const config = path.join(root, "explicit.json"); await writeFile(config, JSON.stringify({ version: 1, repositories: [{ path: "api" }] }));
    const named = run(["--workspace", config], process.cwd()); assert.equal(named.status, 0, named.stderr); assert.equal(JSON.parse(named.stdout).repositories.length, 1);
    for (const args of [[], ["--repo"], ["--repo", repo, "--workspace", config], ["--limit", "no", "--repo", repo], ["--unknown", "x"]]) {
      const result = run(args, process.cwd()); assert.equal(result.status, 1); assert.ok(JSON.parse(result.stdout).error);
    }
    const empty = run(["--repo", path.join(root, "missing")], process.cwd()); assert.equal(empty.status, 1); assert.equal(JSON.parse(empty.stdout).state, "unavailable");
    await writeFile(config, "{"); assert.equal(run(["--workspace", config], process.cwd()).status, 1);
  } finally { await rm(root, { recursive: true, force: true }); }
});
