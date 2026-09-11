import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execFile = promisify(execFileCallback);
const root = path.resolve(".");
const cliPath = path.join(root, "src/cli.ts");
const tsxLoader = createRequire(import.meta.url).resolve("tsx/esm");
const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { version: string };

async function runCli(args: string[]) {
  const cwd = await mkdtemp(path.join(tmpdir(), "code-atlas-startup-"));
  try {
    return await execFile(process.execPath, ["--import", tsxLoader, cliPath, ...args], {
      cwd,
      env: { ...process.env, HOME: cwd, XDG_CONFIG_HOME: path.join(cwd, "xdg"), NO_COLOR: "1" },
    });
  } finally {
    await import("node:fs/promises").then(({ rm }) => rm(cwd, { recursive: true, force: true }));
  }
}

for (const flag of ["--version", "-v"]) {
  test(`CLI ${flag} prints the package version without storage startup`, async () => {
    const result = await runCli([flag]);
    assert.equal(result.stdout.trim(), packageJson.version);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stderr, /SQLite is an experimental feature/);
  });
}

for (const flag of ["--help", "-h"]) {
  test(`CLI ${flag} prints help without storage startup`, async () => {
    const result = await runCli([flag]);
    assert.match(result.stdout, /Usage: code-atlas <command>/);
    assert.equal(result.stderr, "");
    assert.doesNotMatch(result.stderr, /SQLite is an experimental feature/);
  });
}

test("unknown commands remain errors", async () => {
  await assert.rejects(
    runCli(["unknown"]),
    (error: { code?: number; stderr?: string }) => error.code === 1 && /Unknown command/.test(error.stderr ?? ""),
  );
});
