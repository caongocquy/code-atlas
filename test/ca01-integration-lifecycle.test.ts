import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { assertFreshMcpInitialize } from "./helpers/mcp-initialize.js";
import { resolveIntegrationEnvironment, integrationPathApi } from "../src/infrastructure/integration/integration-environment.js";
import { codexConfigPath, openCodeConfigPath } from "../src/infrastructure/integration/config-paths.js";

test("MCP initialize fixture waits for graceful subprocess exit and releases its working directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "ca01-mcp-close-"));
  try {
    const script = `
      process.stdin.once("data", () => console.log(JSON.stringify({jsonrpc:"2.0",id:1,result:{serverInfo:{name:"code-atlas"}}})));
      process.stdin.on("end", () => setTimeout(() => require("node:fs").writeFileSync("closed.txt", "done"), 100));
      process.stdin.resume();
    `;
    await assertFreshMcpInitialize(process.execPath, ["-e", script], root);
    assert.equal(await readFile(path.join(root, "closed.txt"), "utf8"), "done");
    await assert.rejects(() => assertFreshMcpInitialize(process.execPath, ["-e", "process.stdin.once('data', () => process.exit(2))"], root), /MCP exited before initialize response/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pure POSIX and Windows integration environments use the requested path syntax on every host", () => {
  const posix = resolveIntegrationEnvironment({ platform: "linux", home: "/home/test", cwd: "/work/repo", env: {} });
  assert.equal(posix.home, "/home/test");
  assert.equal(codexConfigPath(posix), "/home/test/.codex/config.toml");
  assert.equal(openCodeConfigPath(posix, "project"), "/work/repo/opencode.jsonc");
  assert.equal(integrationPathApi(posix).delimiter, ":");
  const windows = resolveIntegrationEnvironment({ platform: "win32", cwd: "C:\\work", env: { USERPROFILE: "C:\\Users\\test" } });
  assert.equal(windows.home, "C:\\Users\\test");
  assert.equal(codexConfigPath(windows), "C:\\Users\\test\\.codex\\config.toml");
  assert.equal(integrationPathApi(windows).delimiter, ";");
  const hostBacked = resolveIntegrationEnvironment({ platform: "linux", home: process.cwd(), cwd: process.cwd(), env: {} });
  assert.equal(codexConfigPath(hostBacked), path.join(process.cwd(), ".codex", "config.toml"));
  assert.equal(integrationPathApi(hostBacked).delimiter, path.delimiter);
});
