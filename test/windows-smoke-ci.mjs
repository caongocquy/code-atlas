import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../dist/cli.js", import.meta.url));
const runOnnxOnly = process.argv.includes("--onnx-only");
const root = fs.mkdtempSync(path.join(os.tmpdir(), "Code Atlas Windows Smoke "));
const fixtureFile = path.join(root, "src", "calc.ts");

function runCli(args, timeout = 180000) {
  const started = performance.now();
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout,
    maxBuffer: 8 * 1024 * 1024,
    windowsHide: true,
    env: { ...process.env, NO_COLOR: "1" },
  });
  const elapsedMs = Math.round(performance.now() - started);
  if (result.error || result.status !== 0) {
    throw new Error(
      "code-atlas " + args.join(" ") + " failed in " + elapsedMs + "ms: " +
      (result.error?.message ?? "exit " + result.status) + "\n" +
      result.stdout + "\n" + result.stderr,
    );
  }
  const diagnostics = result.stderr.split(/\r?\n/).filter((line) => line.startsWith("CODEATLAS_"));
  console.log(JSON.stringify({ command: args.join(" "), elapsedMs, diagnostics }));
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw new Error("Expected JSON-only CLI output: " + result.stdout);
  }
}

function assertNoop(value) {
  assert.equal(value.kind, "published");
  assert.equal(value.generationReused, true);
  assert.deepEqual(value.changes.addedFiles, []);
  assert.deepEqual(value.changes.changedFiles, []);
  assert.deepEqual(value.changes.deletedFiles, []);
  for (const key of [
    "filesParsed", "filesResolved", "frameworkFilesResolved",
    "lexicalFilesUpdated", "semanticUnitsEmbedded", "storageTransactions",
  ]) {
    assert.equal(value.counters[key], 0, key + " should be zero on no-op");
  }
}

function createFixture() {
  fs.mkdirSync(path.dirname(fixtureFile), { recursive: true });
  fs.writeFileSync(fixtureFile, "export function calc(): number { return 1; }\n");
  fs.writeFileSync(path.join(root, "src", "entry.ts"),
    'import { calc } from "./calc.js";\nexport function entry(): number { return calc(); }\n');
  fs.writeFileSync(path.join(root, "README.md"), "Temporary Windows smoke fixture\n");
}

try {
  assert.equal(process.platform, "win32", "This smoke harness must run on Windows");
  assert.ok(fs.existsSync(cli), "Built CLI is missing");
  createFixture();

  if (!runOnnxOnly) {
    const first = runCli(["index", "--skip-git", "--json", "--diagnostic-timings"], 300000);
    assert.equal(first.kind, "published");
    const noOp = runCli(["sync", "--skip-git", "--json", "--diagnostic-timings"]);
    assertNoop(noOp);
    assert.equal(noOp.generationId, first.generationId);

    fs.writeFileSync(fixtureFile, "export function calc(): number { return 2; }\n");
    const delta = runCli(["sync", "--skip-git", "--json", "--diagnostic-timings"], 300000);
    assert.equal(delta.kind, "published");
    assert.deepEqual(delta.changes.addedFiles, []);
    assert.deepEqual(delta.changes.changedFiles, ["src/calc.ts"]);
    assert.equal(delta.counters.filesParsed, 1);
    assert.equal(delta.lexical.indexedFiles, 1);

    const currentIndex = runCli(["index", "--skip-git", "--json"]);
    assert.equal(currentIndex.generationReused, true);
    assert.equal(currentIndex.generationId, delta.generationId);

    const reindex = runCli(["reindex", "--skip-git", "--json", "--diagnostic-timings"], 300000);
    assert.equal(reindex.kind, "published");
    assert.equal(reindex.graph.fullRebuild, true);
    assert.notEqual(reindex.generationId, delta.generationId);
    assertNoop(runCli(["sync", "--skip-git", "--json"]));

    const status = runCli(["status", "--json"]);
    assert.ok(status && typeof status === "object");
    console.log("WINDOWS_CORE_SMOKE_PASS");
  } else {
    const setup = runCli(["semantic", "setup", "--provider", "builtin-local", "--json"], 900000);
    assert.equal(setup.result.status, "configured");
    const first = runCli(["index", "--skip-git", "--json", "--diagnostic-timings"], 900000);
    assert.equal(first.kind, "published");
    assert.ok(first.counters.semanticUnitsEmbedded > 0, "Expected real ONNX embeddings");
    const noOp = runCli(["sync", "--skip-git", "--json", "--diagnostic-timings"], 180000);
    assertNoop(noOp);
    assert.equal(noOp.generationId, first.generationId);
    fs.writeFileSync(fixtureFile, "export function calc(): number { return 3; }\n");
    const delta = runCli(["sync", "--skip-git", "--json", "--diagnostic-timings"], 900000);
    assert.equal(delta.kind, "published");
    assert.ok(delta.counters.semanticUnitsEmbedded > 0);
    assert.ok(delta.counters.semanticUnitsEmbedded < first.counters.semanticUnitsEmbedded,
      "Changed-file sync should not re-embed entire corpus");
    assert.equal(delta.counters.filesParsed, 1);
    console.log("WINDOWS_ONNX_SMOKE_PASS");
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 6, retryDelay: 300 });
}
