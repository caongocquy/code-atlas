import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { changeGate } from "../src/core/gate/change-gate.service.js";
import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";

const execFile = promisify(execFileCallback);

async function git(repoPath: string, args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd: repoPath, encoding: "utf8" });
  return String(result.stdout);
}

async function files(repoPath: string, values: Record<string, string>): Promise<void> {
  for (const [file, content] of Object.entries(values)) {
    const target = path.join(repoPath, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
}

async function withRepo(values: Record<string, string>, callback: (repoPath: string) => Promise<void>): Promise<void> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-gate-"));
  try {
    await files(repoPath, values);
    await git(repoPath, ["init", "-q"]);
    await git(repoPath, ["config", "user.email", "test@example.com"]);
    await git(repoPath, ["config", "user.name", "CodeAtlas Test"]);
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-qm", "initial"]);
    await callback(repoPath);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
}

const gate = (value: unknown): string => JSON.stringify({ version: 1, gate: value }, null, 2);

test("changeGate is not configured without a gate section", async () => {
  await withRepo({ "src/a.ts": "export const a = 1;\n" }, async (repoPath) => {
    const result = await changeGate(repoPath);
    assert.equal(result.status, "not_configured");
    assert.equal(result.policy.enforcementSource, "none");
  });
});

test("changeGate rejects an empty gate policy", async () => {
  await withRepo({ "codeatlas.config.json": gate({}), "src/a.ts": "export const a = 1;\n" }, async (repoPath) => {
    await assert.rejects(() => changeGate(repoPath), /gate must contain at least one effective check/i);
  });
});

test("changeGate enforces risk and keeps unknown risk conservative", async () => {
  await withRepo({
    "codeatlas.config.json": gate({ risk: { maxAllowed: "medium" } }),
    "src/a.ts": "export function a() { return 1; }\n",
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/a.ts"), "export function a(target: unknown, method: string) { return (target as Record<string, () => number>)[method](); }\n");
    const result = await changeGate(repoPath);
    assert.equal(result.status, "fail");
    assert.equal(result.checks.some((check) => check.id === "risk.allowUnknown" && check.status === "fail"), true);

  });
  await withRepo({
    "codeatlas.config.json": gate({ risk: { maxAllowed: "medium", allowUnknown: true } }),
    "src/a.ts": "export function a() { return 1; }\n",
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/a.ts"), "export function a(target: unknown, method: string) { return (target as Record<string, () => number>)[method](); }\n");
    const allowed = await changeGate(repoPath);
    assert.equal(allowed.checks.find((check) => check.id === "risk.allowUnknown")?.status, "pass");
    assert.equal(allowed.checks.find((check) => check.id === "risk.maxAllowed")?.status, "skipped");
  });
});

test("changeGate applies self-bypass protection and target preview", async () => {
  await withRepo({
    "codeatlas.config.json": gate({ risk: { maxAllowed: "medium", allowUnknown: false } }),
    "src/a.ts": "export function a() { return 1; }\n",
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/a.ts"), "export function a() { return 2; }\n");
    await writeFile(path.join(repoPath, "codeatlas.config.json"), gate({ risk: { maxAllowed: "high", allowUnknown: true } }));
    const result = await changeGate(repoPath);
    assert.equal(result.policy.enforcementSource, "baseline");
    assert.equal(result.status, "fail");
    assert.equal(result.preview?.status, "pass");
    assert.equal(result.policy.semanticChanged, true);
  });
});

test("changeGate bootstraps a newly added target policy", async () => {
  await withRepo({ "src/a.ts": "export function a() { return 1; }\n" }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/a.ts"), "export function a() { return 2; }\n");
    await writeFile(path.join(repoPath, "codeatlas.config.json"), gate({ risk: { maxAllowed: "medium", allowUnknown: false } }));
    const result = await changeGate(repoPath);
    assert.equal(result.policy.enforcementSource, "target_bootstrap");
    assert.equal(result.status, "fail");
    assert.equal(result.policy.baseline.configured, false);
    assert.equal(result.policy.target.configured, true);
  });
});

test("changeGate enforces known test gaps and architecture findings without hiding evidence", async () => {
  await withRepo({
    "codeatlas.config.json": JSON.stringify({
      version: 1,
      architecture: {
        groups: [{ id: "ui", include: ["src/ui/**"] }, { id: "data", include: ["src/data/**"] }],
        rules: [{ id: "ui-no-data", from: "ui", to: "data", action: "deny", edgeKinds: ["imports"], severity: "high" }],
      },
      gate: { tests: { maxUncoveredAffectedSymbols: 0 }, architecture: { failOnSeverityAtLeast: "high" } },
    }, null, 2),
    "src/ui/screen.ts": "export function render() { return true; }\n",
    "src/data/repository.ts": "export function repository() { return true; }\n",
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/ui/screen.ts"), 'import { repository } from "../data/repository.js";\nexport function render() { return repository(); }\n');
    const result = await changeGate(repoPath);
    assert.equal(result.status, "fail");
    assert.equal(result.checks.find((check) => check.id === "tests.maxUncoveredAffectedSymbols")?.status, "fail");
    assert.equal(result.checks.find((check) => check.id === "architecture.introducedSeverity")?.status, "fail");
    assert.equal(result.checks.filter((check) => check.status === "fail").length >= 2, true);
  });
});

test("changeGate uses staged and historical gate snapshots, not live config", async () => {
  await withRepo({
    "codeatlas.config.json": gate({ risk: { maxAllowed: "high", allowUnknown: true } }),
    "src/a.ts": "export function a() { return 1; }\n",
  }, async (repoPath) => {
    const first = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(repoPath, "codeatlas.config.json"), gate({ risk: { maxAllowed: "medium", allowUnknown: false } }));
    await git(repoPath, ["add", "codeatlas.config.json"]);
    await writeFile(path.join(repoPath, "codeatlas.config.json"), gate({ risk: { maxAllowed: "low", allowUnknown: false } }));
    const staged = await changeGate(repoPath, { mode: "staged" });
    assert.equal(staged.policy.target.sourceKind, "git_index");
    assert.notEqual(staged.policy.target.semanticHash, staged.policy.baseline.semanticHash);

    await git(repoPath, ["commit", "-qm", "policy-medium"]);
    const second = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(repoPath, "codeatlas.config.json"), gate({ risk: { maxAllowed: "high", allowUnknown: true } }));
    const historical = await changeGate(repoPath, { mode: "range", base: first, head: second });
    assert.equal(historical.policy.baseline.sourceKind, "git_revision");
    assert.equal(historical.policy.target.sourceKind, "git_revision");
    assert.notEqual(historical.policy.target.semanticHash, historical.policy.baseline.semanticHash);
  });
});

test("changeGate preserves config and returns structured JSON through MCP-facing core", async () => {
  await withRepo({ "codeatlas.config.json": gate({ diagnostics: { forbidGapKinds: ["dynamic_dispatch"] } }), "src/a.ts": "export const a = 1;\n" }, async (repoPath) => {
    const before = await readFile(path.join(repoPath, "codeatlas.config.json"), "utf8");
    const result = await changeGate(repoPath);
    assert.equal(typeof result.status, "string");
    assert.equal(await readFile(path.join(repoPath, "codeatlas.config.json"), "utf8"), before);
  });
});

test("change_gate is listed and returns structured not_configured state", async () => {
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "change-gate-test", version: "1.0.0" });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    assert.equal((await client.listTools()).tools.some((tool) => tool.name === "change_gate"), true);
    await withRepo({ "src/a.ts": "export const a = 1;\n" }, async (repoPath) => {
      const result = await client.callTool({ name: "change_gate", arguments: { repoPath } });
      const text = result.content.find((item) => item.type === "text");
      assert.ok(text && text.type === "text");
      assert.equal((JSON.parse(text.text) as { status: string }).status, "not_configured");
      const unsupported = await client.callTool({ name: "change_gate", arguments: { repoPath, configPath: "alternate.json" } });
      assert.equal(unsupported.isError, true);
    });
  } finally {
    await client.close();
    await server.close();
  }
});
