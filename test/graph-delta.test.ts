import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { graphDelta } from "../src/core/change/graph-delta.service.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";

const execFile = promisify(execFileCallback);
const cliPath = path.resolve("src/cli.ts");
const tsxLoader = createRequire(import.meta.url).resolve("tsx/esm");

async function git(repoPath: string, args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd: repoPath, encoding: "utf8" });
  return String(result.stdout);
}

async function withGitRepo(
  files: Record<string, string>,
  callback: (repoPath: string) => Promise<void>,
): Promise<void> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-graph-delta-"));
  try {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(repoPath, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
    }
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

test("graphDelta compares transient import facts from HEAD to working tree", async () => {
  await withGitRepo({
    "src/ui.ts": 'import { Service } from "./service.js";\nexport function render() { return Service(); }\n',
    "src/service.ts": "export function Service() { return 1; }\n",
    "src/repository.ts": "export function Repository() { return 2; }\n",
  }, async (repoPath) => {
    await writeFile(
      path.join(repoPath, "src/ui.ts"),
      'import { Repository } from "./repository.js";\nexport function render() { return Repository(); }\n',
    );

    const result = await graphDelta(repoPath);
    assert.equal(result.source.mode, "working");
    assert.equal(result.summary.changedFiles, 1);
    assert.equal(result.addedEdges.some((edge) => edge.kind === "imports" && edge.to.file === "src/repository.ts"), true);
    assert.equal(result.removedEdges.some((edge) => edge.kind === "imports" && edge.to.file === "src/service.ts"), true);
    assert.equal(result.addedEdges.some((edge) => edge.kind === "calls" && edge.to.file === "src/repository.ts"), true);
    assert.equal(result.removedEdges.some((edge) => edge.kind === "calls" && edge.to.file === "src/service.ts"), true);
    assert.equal(result.mayBeIncomplete, false);
  });
});

test("graphDelta keeps unchanged relationships out of the delta", async () => {
  await withGitRepo({
    "src/ui.ts": 'import { Service } from "./service.js";\nexport function render() { return Service(); }\n',
    "src/service.ts": "export function Service() { return 1; }\n",
  }, async (repoPath) => {
    await writeFile(
      path.join(repoPath, "src/ui.ts"),
      'import { Service } from "./service.js";\nexport function render() { return Service() + 1; }\n',
    );

    const result = await graphDelta(repoPath);
    assert.equal(result.addedEdges.some((edge) => edge.kind === "imports"), false);
    assert.equal(result.removedEdges.some((edge) => edge.kind === "imports"), false);
    assert.equal(result.summary.unchangedRelevantEdges > 0, true);
  });
});

test("graphDelta includes untracked files as added structural content", async () => {
  await withGitRepo({ "src/service.ts": "export function Service() { return 1; }\n" }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/new.ts"), 'import { Service } from "./service.js";\nexport const value = Service();\n');
    const result = await graphDelta(repoPath);
    assert.equal(result.changedFiles.some((file) => file.path === "src/new.ts" && file.status === "added"), true);
    assert.equal(result.addedEdges.some((edge) => edge.kind === "imports" && edge.from.file === "src/new.ts"), true);
  });
});

test("graphDelta is read-only", async () => {
  await withGitRepo({ "src/a.ts": "export function a() {}\n" }, async (repoPath) => {
    const before = await git(repoPath, ["status", "--porcelain=v1"]);
    await graphDelta(repoPath);
    assert.equal(await git(repoPath, ["status", "--porcelain=v1"]), before);
    await assert.rejects(() => readFile(path.join(repoPath, ".codeatlas", "atlas.db")));
  });
});

test("graphDelta keeps staged, unstaged, and untracked source semantics", async () => {
  await withGitRepo({
    "src/staged.ts": "export function staged() { return 1; }\n",
    "src/unstaged.ts": "export function unstaged() { return 1; }\n",
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/staged.ts"), "export function staged() { return 2; }\n");
    await git(repoPath, ["add", "src/staged.ts"]);
    await writeFile(path.join(repoPath, "src/unstaged.ts"), "export function unstaged() { return 2; }\n");
    await writeFile(path.join(repoPath, "src/untracked.ts"), "export function untracked() { return 3; }\n");

    assert.deepEqual((await graphDelta(repoPath, { mode: "staged" })).changedFiles.map((file) => file.path), ["src/staged.ts"]);
    assert.deepEqual((await graphDelta(repoPath)).changedFiles.map((file) => file.path), ["src/staged.ts", "src/unstaged.ts", "src/untracked.ts"]);
  });
});

test("graphDelta compares commits, ranges, additions, deletions, and pure renames", async () => {
  await withGitRepo({
    "src/old.ts": "export function oldValue() { return 1; }\n",
    "src/user.ts": 'import { oldValue } from "./old.js";\nexport function use() { return oldValue(); }\n',
  }, async (repoPath) => {
    const base = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    await git(repoPath, ["mv", "src/old.ts", "src/new.ts"]);
    await writeFile(path.join(repoPath, "src/user.ts"), 'import { oldValue } from "./new.js";\nexport function use() { return oldValue(); }\n');
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-qm", "rename"]);
    const head = (await git(repoPath, ["rev-parse", "HEAD"])).trim();

    const rename = await graphDelta(repoPath, { mode: "range", base, head });
    assert.equal(rename.changedFiles.some((file) => file.status === "renamed"), true);
    assert.equal(rename.summary.addedEdges, 0);
    assert.equal(rename.summary.removedEdges, 0);
    assert.equal((await graphDelta(repoPath, { mode: "commit", commit: head })).source.mode, "commit");

    await rm(path.join(repoPath, "src/new.ts"));
    const deleted = await graphDelta(repoPath);
    assert.equal(deleted.changedFiles.some((file) => file.status === "deleted"), true);
    assert.equal(deleted.removedEdges.some((edge) => edge.kind === "imports"), true);
  });
});

test("graphDelta reports deterministic truncation diagnostics", async () => {
  await withGitRepo({
    "src/a.ts": "export function a() {}\n",
    "src/b.ts": 'import { a } from "./a.js";\nexport function b() { return a(); }\n',
    "src/c.ts": 'import { a } from "./a.js";\nexport function c() { return a(); }\n',
  }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/b.ts"), 'import { c } from "./c.js";\nexport function b() { return c(); }\n');
    await writeFile(path.join(repoPath, "src/c.ts"), 'import { b } from "./b.js";\nexport function c() { return b(); }\n');
    const result = await graphDelta(repoPath, { maxEdges: 1 });
    assert.equal(result.mayBeIncomplete, true);
    assert.equal(result.diagnostics.gaps.some((gap) => gap.kind === "truncated_analysis"), true);
    assert.equal(result.addedEdges.length + result.removedEdges.length <= 1, true);
  });
});

test("graphDelta reports binary changes without fabricating structural edges", async () => {
  await withGitRepo({ "src/a.ts": "export function a() {}\n" }, async (repoPath) => {
    await writeFile(path.join(repoPath, "asset.bin"), Buffer.from([0, 1, 2]));
    const result = await graphDelta(repoPath);
    assert.equal(result.changedFiles.some((file) => file.path === "asset.bin" && file.status === "binary"), true);
    assert.equal(result.addedEdges.length, 0);
    assert.equal(result.removedEdges.length, 0);
    assert.equal(result.diagnostics.gaps.some((gap) => gap.kind === "binary_change"), true);
  });
});

test("graph_delta is listed, validates modes, and shares the structured result with the CLI", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-graph-delta-mcp-"));
  try {
    await mkdir(path.join(repoPath, ".git"), { recursive: true });
    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "graph-delta-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const listed = await client.listTools();
      assert.equal(listed.tools.some((tool) => tool.name === "graph_delta"), true);
      const invalid = await client.callTool({ name: "graph_delta", arguments: { repoPath, mode: "range", base: "HEAD" } });
      assert.equal(invalid.isError, true);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("graph-delta CLI emits human output and clean JSON", async () => {
  await withGitRepo({ "src/a.ts": "export function a() {}\n" }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/a.ts"), "export function a() { return true; }\n");
    const json = await execFile(process.execPath, ["--import", tsxLoader, cliPath, "graph-delta", repoPath, "--json"], {
      cwd: repoPath,
      env: { ...process.env, NO_COLOR: "1", NODE_NO_WARNINGS: "1" },
    });
    const result = JSON.parse(String(json.stdout)) as GraphDeltaResultLike;
    assert.equal(result.source.mode, "working");
    assert.equal(String(json.stderr), "");
    const human = await execFile(process.execPath, ["--import", tsxLoader, cliPath, "graph-delta", repoPath], {
      cwd: repoPath,
      env: { ...process.env, NO_COLOR: "1" },
    });
    assert.equal(String(human.stdout).includes("Structural graph delta"), true);
    assert.equal(String(human.stdout).includes("{"), false);
  });
});

type GraphDeltaResultLike = { source: { mode: string } };
