import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createRequire } from "node:module";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { getRepositoryStatus } from "../src/core/repository/repository-status.service.js";
import { runInitCommand } from "../src/adapters/cli/init.command.js";

const execFile = promisify(execFileCallback);
const cliPath = path.resolve("src/cli.ts");
const tsxLoader = createRequire(import.meta.url).resolve("tsx/esm");

async function fixture(name: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `code-atlas-phase-11k-${name}-`));
}

async function runCli(repoPath: string, ...args: string[]): Promise<{ stdout: string; stderr: string }> {
  return execFile(process.execPath, ["--import", tsxLoader, cliPath, ...args], {
    cwd: repoPath,
    env: { ...process.env, HOME: repoPath, NO_COLOR: "1" },
  });
}

test("init indexes graph and lexical capabilities by default", async () => {
  const repoPath = await fixture("default-index");
  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");
    const result = await runCli(repoPath, "init", "--json");
    const output = JSON.parse(result.stdout) as Record<string, any>;
    const status = await getRepositoryStatus(repoPath);
    const guidance = await readFile(path.join(repoPath, "AGENTS.md"), "utf8");

    assert.equal(output.indexed, true);
    assert.equal(output.graph.status, "ready");
    assert.equal(output.lexical.status, "ready");
    assert.equal(status.graph.status, "ready");
    assert.equal(status.capabilities.lexical.state, "ready");
    assert.match(guidance, /- graph: ready/);
    assert.match(guidance, /- lexical: ready/);
    assert.match(guidance, /find_callers/);
    assert.equal(guidance.match(/### Reporting/g)?.length, 1);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("init --no-index skips graph and lexical indexing", async () => {
  const repoPath = await fixture("no-index");
  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");
    const result = await runCli(repoPath, "init", "--no-index", "--json");
    const output = JSON.parse(result.stdout) as Record<string, any>;
    const status = await getRepositoryStatus(repoPath);
    const guidance = await readFile(path.join(repoPath, "AGENTS.md"), "utf8");

    assert.equal(output.indexed, false);
    assert.equal(output.graph.status, "not_indexed");
    assert.equal(output.lexical.status, "not_indexed");
    assert.equal(status.graph.status, "not_indexed");
    assert.equal(status.capabilities.lexical.state, "not_indexed");
    assert.match(guidance, /- graph: not-indexed/);
    assert.match(guidance, /- lexical: not-indexed/);
    assert.match(guidance, /code-atlas index/);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("init preserves bootstrap when indexing fails and exits non-zero", async () => {
  const repoPath = await fixture("index-failure");
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  let calls = 0;
  try {
    await runInitCommand(["--json"], repoPath, {
      indexRepository: async () => {
        calls += 1;
        throw new Error("index unavailable");
      },
    });

    assert.equal(calls, 1);
    assert.equal(process.exitCode, 1);
    await access(path.join(repoPath, ".codeatlas", "atlas.db"));
    const status = await getRepositoryStatus(repoPath);
    assert.equal(status.graph.status, "not_indexed");
    assert.equal(status.capabilities.lexical.state, "not_indexed");
  } finally {
    process.exitCode = previousExitCode;
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("init --no-index preserves an existing graph and lexical index", async () => {
  const repoPath = await fixture("preserve-index");
  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");
    await runCli(repoPath, "init", "--json");
    const before = await getRepositoryStatus(repoPath);
    assert.equal(before.graph.status, "ready");
    assert.equal(before.capabilities.lexical.state, "ready");

    const result = await runCli(repoPath, "init", "--no-index", "--json");
    const output = JSON.parse(result.stdout) as Record<string, any>;
    const after = await getRepositoryStatus(repoPath);

    assert.equal(output.indexed, false);
    assert.equal(output.graph.status, before.graph.status);
    assert.equal(output.lexical.status, before.capabilities.lexical.state);
    assert.equal(after.graph.status, before.graph.status);
    assert.equal(after.capabilities.lexical.state, before.capabilities.lexical.state);
    assert.equal(after.graph.indexedFiles, before.graph.indexedFiles);
    assert.equal(after.graph.nodes, before.graph.nodes);
    assert.equal(after.graph.edges, before.graph.edges);
    assert.equal(after.capabilities.lexical.indexedFiles, before.capabilities.lexical.indexedFiles);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
