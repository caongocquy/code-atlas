import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { acquireIndexWriterLock, IndexWriterLockError } from "../src/core/indexing/index-writer-lock.js";

async function withTempRepository<T>(callback: (repoPath: string) => Promise<T>): Promise<T> {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "code-atlas-writer-lock-"));
  try {
    return await callback(repoPath);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
}

function spawnLockHolder(repoPath: string, action: "hold" | "crash") {
  const moduleUrl = pathToFileURL(path.resolve("src/core/indexing/index-writer-lock.ts")).href;
  const script = `
    import { acquireIndexWriterLock } from ${JSON.stringify(moduleUrl)};
    const release = await acquireIndexWriterLock(process.argv[1]);
    process.stdout.write("acquired\\n");
    if (process.argv[2] === "crash") process.exit(0);
    process.stdin.once("data", async () => { await release(); process.exit(0); });
  `;
  return spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script, repoPath, action], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: process.cwd(),
  });
}

function spawnLockContender(repoPath: string) {
  const moduleUrl = pathToFileURL(path.resolve("src/core/indexing/index-writer-lock.ts")).href;
  const script = `
    import { acquireIndexWriterLock } from ${JSON.stringify(moduleUrl)};
    try {
      const release = await acquireIndexWriterLock(process.argv[1]);
      process.stdout.write("acquired\\n");
      process.stdin.once("data", async () => { await release(); process.exit(0); });
    } catch (error) {
      if (error?.code !== "INDEX_OPERATION_ALREADY_RUNNING") throw error;
      process.stdout.write("blocked\\n");
      process.exit(0);
    }
  `;
  return spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "-e", script, repoPath], {
    stdio: ["pipe", "pipe", "pipe"],
    cwd: process.cwd(),
  });
}

function readFirstLine(child: ReturnType<typeof spawn>): Promise<string> {
  return new Promise((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      const newline = output.indexOf("\n");
      if (newline >= 0) resolve(output.slice(0, newline));
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`contender exited before reporting (${code}): ${output}`)));
  });
}

async function waitForAcquired(child: ReturnType<typeof spawn>): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    let output = "";
    child.stdout?.on("data", (chunk: Buffer) => {
      output += chunk.toString();
      if (output.includes("acquired\n")) resolve();
    });
    child.once("error", reject);
    child.once("exit", (code) => reject(new Error(`lock holder exited before acquisition (${code}): ${output}`)));
  });
}

test("rejects a second process while a writer is active", async () => {
  await withTempRepository(async (repoPath) => {
    const child = spawnLockHolder(repoPath, "hold");
    try {
      await waitForAcquired(child);
      await assert.rejects(acquireIndexWriterLock(repoPath), (error: unknown) => {
        assert.ok(error instanceof IndexWriterLockError);
        assert.equal(error.code, "INDEX_OPERATION_ALREADY_RUNNING");
        return true;
      });
    } finally {
      child.stdin?.end();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
    const release = await acquireIndexWriterLock(repoPath);
    await release();
  });
});

test("allows only one writer when processes acquire at the same time", async () => {
  await withTempRepository(async (repoPath) => {
    const children = Array.from({ length: 6 }, () => spawnLockContender(repoPath));
    try {
      const results = await Promise.all(children.map(readFirstLine));
      assert.equal(results.filter((result) => result === "acquired").length, 1);
      assert.equal(results.filter((result) => result === "blocked").length, children.length - 1);
    } finally {
      for (const child of children) child.stdin?.end();
      await Promise.all(children.map((child) => new Promise<void>((resolve) => {
        if (child.exitCode !== null) resolve();
        else child.once("exit", () => resolve());
      })));
    }
  });
});

test("recovers the writer lock after the owning process crashes", async () => {
  await withTempRepository(async (repoPath) => {
    const child = spawnLockHolder(repoPath, "crash");
    await waitForAcquired(child);
    await new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code) => code === 0 ? resolve() : reject(new Error(`lock holder exited with ${code}`)));
    });

    const release = await acquireIndexWriterLock(repoPath);
    await release();
  });
});

test("retains the lock after an awaiting caller gives up on its operation", async () => {
  await withTempRepository(async (repoPath) => {
    const child = spawnLockHolder(repoPath, "hold");
    try {
      await waitForAcquired(child);
      const underlyingOperation = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      const timedOut = await Promise.race([
        underlyingOperation.then(() => false),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 20)),
      ]);
      assert.equal(timedOut, true);
      await assert.rejects(acquireIndexWriterLock(repoPath), IndexWriterLockError);
    } finally {
      child.stdin?.end();
      await new Promise<void>((resolve) => child.once("exit", () => resolve()));
    }
  });
});
