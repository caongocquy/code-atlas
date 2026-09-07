import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { affectedTests, isTestFile } from "../src/core/change/affected-tests.service.js";
import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";

const execFile = promisify(execFileCallback);
const cliPath = path.resolve("src/cli.ts");
const tsxLoader = createRequire(import.meta.url).resolve("tsx/esm");

async function git(repoPath: string, args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd: repoPath, encoding: "utf8" });
  return String(result.stdout);
}

async function fixture(): Promise<string> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-affected-tests-"));
  for (const [file, content] of Object.entries({
    ".gitignore": ".codeatlas/\n",
    "src/a.ts": "export function alpha() { return 1; }\n",
    "src/b.ts": "import { alpha } from './a.js';\nexport function beta() { return alpha(); }\n",
    "src/c.ts": "export function gamma() { return 1; }\n",
    "test/a.test.ts": "import { alpha } from '../src/a.js';\nexport function alphaTest() { return alpha(); }\n",
    "tests/integration.spec.ts": "import { beta } from '../src/b.js';\nexport function integrationTest() { return beta(); }\n",
    "src/contest.ts": "export function contest() { return true; }\n",
  })) {
    const target = path.join(repoPath, file);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  await git(repoPath, ["init", "-q"]);
  await git(repoPath, ["config", "user.email", "test@example.com"]);
  await git(repoPath, ["config", "user.name", "CodeAtlas Test"]);
  await git(repoPath, ["add", "."]);
  await git(repoPath, ["commit", "-qm", "initial"]);
  return repoPath;
}

test("test-file classification is conservative and convention based", () => {
  assert.equal(isTestFile("test/a.test.ts"), true);
  assert.equal(isTestFile("src/a.spec.ts"), true);
  assert.equal(isTestFile("__tests__/a.ts"), true);
  assert.equal(isTestFile("tests/integration.ts"), true);
  assert.equal(isTestFile("src/contest.ts"), false);
  assert.equal(isTestFile("src/atestimonial.ts"), false);
});

test("affectedTests selects structural test consumers and reports gaps", async () => {
  const repoPath = await fixture();
  try {
    await indexRepository(repoPath, { skipGit: true });
    await writeFile(path.join(repoPath, "src/a.ts"), "export function alpha() { return 2; }\n");
    await writeFile(path.join(repoPath, "src/c.ts"), "export function gamma() { return 2; }\n");

    const result = await affectedTests(repoPath, { mode: "working", maxDepth: 3 });
    assert.deepEqual(result.tests.map((item) => item.file), ["test/a.test.ts", "tests/integration.spec.ts"]);
    assert.equal(result.tests.every((item) => item.reasons.length > 0), true);
    assert.equal(result.tests.find((item) => item.file === "test/a.test.ts")?.confidence, "high");
    assert.equal(result.uncoveredAffectedSymbols.some((symbol) => symbol.name === "gamma" && symbol.reason === "no_structural_test_evidence"), true);
    assert.equal(result.summary.affectedProductionSymbols, 3);
    assert.equal(result.summary.symbolsWithTestEvidence, 2);
    assert.equal(result.summary.uncoveredAffectedSymbols, 1);
    assert.equal(result.mayBeIncomplete, false);
    assert.equal(result.reasons.some((reason) => reason.includes("no indexed structural test evidence")), true);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("affectedTests keeps changed tests separate and aggregates duplicate evidence", async () => {
  const repoPath = await fixture();
  try {
    await indexRepository(repoPath, { skipGit: true });
    await writeFile(path.join(repoPath, "test/a.test.ts"), "import { alpha } from '../src/a.js';\nexport function alphaTest() { return alpha() && true; }\n");
    const result = await affectedTests(repoPath);
    assert.deepEqual(result.changedTests, ["test/a.test.ts"]);
    assert.equal(result.tests.filter((item) => item.file === "test/a.test.ts").length, 0);
    assert.equal(new Set(result.tests.map((item) => item.file)).size, result.tests.length);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("affectedTests preserves inspect_change source modes and reports bounds", async () => {
  const repoPath = await fixture();
  try {
    await indexRepository(repoPath, { skipGit: true });
    const base = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(repoPath, "src/a.ts"), "export function alpha() { return 2; }\n");
    await git(repoPath, ["add", "src/a.ts"]);
    await git(repoPath, ["commit", "-qm", "change alpha"]);
    const head = (await git(repoPath, ["rev-parse", "HEAD"])).trim();
    await writeFile(path.join(repoPath, "src/b.ts"), "import { alpha } from './a.js';\nexport function beta() { return alpha(); }\n");
    await git(repoPath, ["add", "src/b.ts"]);

    assert.equal((await affectedTests(repoPath, { mode: "working" })).source.mode, "working");
    assert.equal((await affectedTests(repoPath, { mode: "staged" })).source.mode, "staged");
    assert.equal((await affectedTests(repoPath, { mode: "commit", commit: head })).source.mode, "commit");
    assert.equal((await affectedTests(repoPath, { mode: "range", base, head })).source.mode, "range");
    const bounded = await affectedTests(repoPath, { maxTests: 1 });
    assert.ok(bounded.tests.length <= 1);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("affected-tests CLI returns structured JSON without decoration", async () => {
  const repoPath = await fixture();
  try {
    const result = await execFile(process.execPath, ["--import", tsxLoader, cliPath, "affected-tests", repoPath, "--json"], {
      cwd: repoPath,
      env: { ...process.env, NO_COLOR: "1" },
    });
    const output = JSON.parse(result.stdout) as { source: { mode: string } };
    assert.equal(output.source.mode, "working");
    assert.equal(result.stderr, "");
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("affected_tests is listed and returns the shared structured result", async () => {
  const repoPath = await fixture();
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "affected-tests-test", version: "1.0.0" });
  try {
    await indexRepository(repoPath, { skipGit: true });
    await writeFile(path.join(repoPath, "src/a.ts"), "export function alpha() { return 2; }\n");
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    assert.equal(listed.tools.some((tool) => tool.name === "affected_tests"), true);
    const response = await client.callTool({ name: "affected_tests", arguments: { repoPath } });
    const text = response.content.find((item) => item.type === "text");
    assert.ok(text && text.type === "text");
    assert.equal((JSON.parse(text.text) as { source: { mode: string } }).source.mode, "working");
    const invalid = await client.callTool({ name: "affected_tests", arguments: { repoPath, mode: "range", base: "HEAD" } });
    assert.equal(invalid.isError, true);
  } finally {
    await client.close();
    await server.close();
    await rm(repoPath, { recursive: true, force: true });
  }
});
