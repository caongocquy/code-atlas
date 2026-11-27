import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import path from "node:path";

function withDeadline<T>(promise: Promise<T>, message: () => string): Promise<T> {
  let timer: NodeJS.Timeout;
  return Promise.race([promise, new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(message())), 10_000);
  })]).finally(() => clearTimeout(timer));
}

export async function assertFreshMcpInitialize(command: string, args: string[], cwd: string): Promise<void> {
  const child = spawn(command, args, {
    cwd,
    env: {
      PATH: [path.dirname(process.execPath), ...(process.platform === "win32" ? [] : ["/usr/bin", "/bin"])].join(path.delimiter),
      HOME: cwd,
      USERPROFILE: cwd,
      SystemRoot: process.env.SystemRoot,
    },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  const closed = new Promise<number | null>(resolve => child.once("close", resolve));
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const response = new Promise<unknown>((resolve, reject) => {
    child.once("error", reject);
    child.stdin.on("error", reject);
    void closed.then(() => reject(new Error(`MCP exited before initialize response. stderr: ${stderr}`)));
    child.stdout.on("data", () => {
      const line = stdout.split("\n").slice(0, -1).find(value => value.trim());
      if (!line) return;
      try { resolve(JSON.parse(line)); }
      catch (error) { reject(error); }
    });
  });
  try {
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "batch-2", version: "1" } },
    })}\n`);
    const message = await withDeadline(response, () => `MCP initialize timed out. stderr: ${stderr}`);
    const result = message as { jsonrpc: string; id: number; result: { serverInfo: { name: string } } };
    assert.equal(result.jsonrpc, "2.0");
    assert.equal(result.id, 1);
    assert.equal(result.result.serverInfo.name, "code-atlas");
    child.stdin.end();
    const exitCode = await withDeadline(closed, () => `MCP did not exit after stdin closed. stderr: ${stderr}`);
    assert.equal(exitCode, 0, stderr);
    assert.ok(stdout.trim().split("\n").every((line) => {
      try { JSON.parse(line); return true; }
      catch { return false; }
    }));
  } finally {
    if (!child.stdin.destroyed) child.stdin.end();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    // Await the actual close event so Windows no longer holds the fixture cwd.
    await withDeadline(closed, () => "MCP subprocess failed to close during cleanup");
  }
}
