import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { inspectChange } from "../src/core/change/inspect-change.service.js";
import { readGitChanges } from "../src/infrastructure/git/git-change-reader.js";
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
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-inspect-change-"));
  try {
    for (const [file, content] of Object.entries(files)) {
      const target = path.join(repoPath, file);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content, { encoding: "utf8" });
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

test("Git change reader distinguishes working, staged, commit, and range changes", async () => {
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "src/a.ts": "export function stagedChange() { return 1; }\n",
    "src/b.ts": "export function unstagedChange() { return 1; }\n",
  }, async (repoPath) => {
    const initial = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    const rootChanges = await readGitChanges(repoPath, { mode: "commit", commit: initial });
    assert.deepEqual(rootChanges.files.map((file) => file.path), [".gitignore", "src/a.ts", "src/b.ts"]);
    await writeFile(path.join(repoPath, "src/a.ts"), "export function stagedChange() { return 2; }\n");
    await writeFile(path.join(repoPath, "src/b.ts"), "export function unstagedChange() { return 2; }\n");
    await git(repoPath, ["add", "src/a.ts", "src/b.ts"]);
    await git(repoPath, ["commit", "-qm", "second"]);
    const commit = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(repoPath, "src/a.ts"), "export function stagedChange() { return 3; }\n");
    await git(repoPath, ["add", "src/a.ts"]);
    await writeFile(path.join(repoPath, "src/b.ts"), "export function unstagedChange() { return 3; }\n");
    await writeFile(path.join(repoPath, "src/untracked.ts"), "export function untracked() {}\n");

    const working = await readGitChanges(repoPath, { mode: "working" });
    assert.deepEqual(working.files.map((file) => [file.path, file.status]), [
      ["src/a.ts", "modified"],
      ["src/b.ts", "modified"],
      ["src/untracked.ts", "added"],
    ]);

    const staged = await readGitChanges(repoPath, { mode: "staged" });
    assert.deepEqual(staged.files.map((file) => file.path), ["src/a.ts"]);

    const commitChanges = await readGitChanges(repoPath, { mode: "commit", commit });
    assert.deepEqual(commitChanges.files.map((file) => file.path), ["src/a.ts", "src/b.ts"]);

    const range = await readGitChanges(repoPath, {
      mode: "range",
      base: initial,
      head: commit,
    });
    assert.deepEqual(range.files.map((file) => file.path), ["src/a.ts", "src/b.ts"]);
  });
});

test("Git change reader preserves rename, deletion, binary, and spaced paths", async () => {
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "old name.ts": "export function renamed() {}\n",
    "asset.bin": Buffer.from([1, 2, 3]),
  }, async (repoPath) => {
    await git(repoPath, ["mv", "old name.ts", "new name.ts"]);
    await rm(path.join(repoPath, "asset.bin"));
    const changes = await readGitChanges(repoPath);
    assert.deepEqual(changes.files.map((file) => [file.oldPath, file.path, file.status]), [
      [undefined, "asset.bin", "deleted"],
      ["old name.ts", "new name.ts", "renamed"],
    ]);
  });
});

test("Git change reader rejects invalid revisions without shell interpretation", async () => {
  await withGitRepo({ "src/a.ts": "export function a() {}\n" }, async (repoPath) => {
    await assert.rejects(
      () => readGitChanges(repoPath, { mode: "commit", commit: "HEAD; touch SHOULD_NOT_EXIST" }),
      /Git change inspection failed/,
    );
    await assert.rejects(() => access(path.join(repoPath, "SHOULD_NOT_EXIST")));
  });
});

test("inspectChange maps changed symbols and reuses bounded graph impact", async () => {
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "src/a.ts": "export function leaf() { return 1; }\n",
    "src/b.ts": "import { leaf } from './a.js';\nexport function middle() { return leaf(); }\n",
    "src/c.ts": "import { middle } from './b.js';\nexport function top() { return middle(); }\n",
  }, async (repoPath) => {
    await indexRepository(repoPath, { skipGit: true });
    await writeFile(path.join(repoPath, "src/a.ts"), "export function leaf() { return 2; }\n");

    const result = await inspectChange(repoPath, { mode: "working", maxDepth: 1 });
    assert.equal(result.summary.changedFiles, 1);
    assert.equal(result.summary.changedSymbols, 1);
    assert.equal(result.changedSymbols[0]?.name, "leaf");
    assert.equal(result.changedSymbols[0]?.changeKind, "modified");
    assert.deepEqual(result.affectedSymbols.map((symbol) => symbol.name), ["middle"]);
    assert.deepEqual(result.affectedFiles, ["src/b.ts"]);
    assert.equal(result.mayBeIncomplete, false);
    assert.equal(result.risk, "low");

    const deeper = await inspectChange(repoPath, { mode: "working", maxDepth: 2 });
    assert.deepEqual(deeper.affectedSymbols.map((symbol) => symbol.name), ["middle", "top"]);
  });
});

test("inspectChange reports unmapped and binary changes without guessing symbols", async () => {
  await withGitRepo({ "src/a.ts": "export function stable() {}\n" }, async (repoPath) => {
    await indexRepository(repoPath, { skipGit: true });
    await writeFile(path.join(repoPath, "src/a.ts"), "// file-level change\nexport function stable() {}\n");
    await writeFile(path.join(repoPath, "asset.bin"), Buffer.from([0, 1, 2, 3]));

    const result = await inspectChange(repoPath, { mode: "working" });
    assert.equal(result.files.some((file) => file.path === "asset.bin" && file.status === "binary"), true);
    assert.equal(result.changedSymbols.some((symbol) => symbol.name === "stable"), false);
    assert.equal(result.mayBeIncomplete, true);
    assert.equal(result.reasons.some((reason) => reason.includes("could not be mapped")), true);
    assert.equal((await readFile(path.join(repoPath, "src/a.ts"), "utf8")).startsWith("// file-level"), true);
  });
});

test("inspectChange uses indexed baseline symbols for deleted files", async () => {
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "src/a.ts": "export function removed() {}\n",
    "src/b.ts": "import { removed } from './a.js';\nexport function caller() { return removed(); }\n",
  }, async (repoPath) => {
    await indexRepository(repoPath, { skipGit: true });
    await rm(path.join(repoPath, "src/a.ts"));
    const result = await inspectChange(repoPath, { mode: "working", maxDepth: 1 });
    assert.equal(result.changedSymbols.some((symbol) => symbol.name === "removed" && symbol.changeKind === "deleted"), true);
    assert.equal(result.affectedSymbols.some((symbol) => symbol.name === "caller"), true);
  });
});

test("inspect-change uses transient evidence when no persisted graph exists", async () => {
  await withGitRepo({ "src/a.ts": "export function stable() {}\n" }, async (repoPath) => {
    await writeFile(path.join(repoPath, "src/a.ts"), "export function stable() { return true; }\n");
    const result = await inspectChange(repoPath);
    assert.equal(result.mayBeIncomplete, false);
    assert.equal(result.risk, "low");
    await assert.rejects(() => access(path.join(repoPath, ".codeatlas", "atlas.db")));
  });
});

test("inspect-change is exposed through MCP and the thin CLI", async () => {
  await withGitRepo({
    ".gitignore": ".codeatlas/\n",
    "src/a.ts": "export function stable() {}\n",
  }, async (repoPath) => {
    await indexRepository(repoPath, { skipGit: true });
    await writeFile(path.join(repoPath, "src/a.ts"), "export function stable() { return true; }\n");

    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "inspect-change-test", version: "1.0.0" });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const toolResult = await client.callTool({ name: "inspect_change", arguments: { repoPath } });
      const text = toolResult.content.find((item) => item.type === "text");
      assert.ok(text && text.type === "text");
      assert.equal((JSON.parse(text.text) as { source: { mode: string } }).source.mode, "working");
      const invalid = await client.callTool({ name: "inspect_change", arguments: { repoPath, mode: "commit" } });
      assert.equal(invalid.isError, true);
    } finally {
      await client.close();
      await server.close();
    }

    const cli = await execFile(process.execPath, ["--import", tsxLoader, cliPath, "inspect-change", repoPath, "--json"], {
      cwd: repoPath,
      env: { ...process.env, NO_COLOR: "1" },
    });
    const output = JSON.parse(cli.stdout) as { summary: { changedFiles: number } };
    assert.equal(output.summary.changedFiles, 1);
    assert.equal(cli.stderr, "");
  });
});
