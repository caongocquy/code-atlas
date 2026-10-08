import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { Writable } from "node:stream";
import { promisify } from "node:util";
import test from "node:test";

import { formatIndexResult, formatInitResult } from "../src/adapters/cli/cli-output.js";
import { formatCommandHelp, formatRootHelp } from "../src/adapters/cli/cli-help.js";
import { createProgressTask, runProgressTasks } from "../src/adapters/cli/cli-progress-reporter.js";
import type { IndexPipelineResult } from "../src/core/indexing/index-pipeline.service.js";

const execFile = promisify(execFileCallback);
const cliPath = path.resolve("src/cli.ts");
const tsxLoader = createRequire(import.meta.url).resolve("tsx/esm");

async function fixture(name: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `code-atlas-cli-ux-${name}-`));
}

async function runCli(repoPath: string, args: string[], extraEnv: NodeJS.ProcessEnv = {}) {
  return execFile(process.execPath, ["--import", tsxLoader, cliPath, ...args], {
    cwd: repoPath,
    env: {
      ...process.env,
      HOME: repoPath,
      CODEX_HOME: path.join(repoPath, ".codex-home"),
      XDG_CONFIG_HOME: path.join(repoPath, ".xdg"),
      NO_COLOR: "1",
      ...extraEnv,
    },
  });
}

const PTY_SCRIPT = [
  "import fcntl, os, pty, select, struct, subprocess, sys, termios",
  "master, slave = pty.openpty()",
  "fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack('HHHH', 24, 90, 0, 0))",
  "child = subprocess.Popen(sys.argv[1:], stdin=slave, stdout=slave, stderr=slave, cwd=os.getcwd())",
  "os.close(slave)",
  "chunks = []",
  "while True:",
  "    ready, _, _ = select.select([master], [], [], 0.1)",
  "    if ready:",
  "        try:",
  "            chunk = os.read(master, 4096)",
  "        except OSError:",
  "            break",
  "        if not chunk:",
  "            break",
  "        chunks.append(chunk)",
  "    elif child.poll() is not None:",
  "        break",
  "status = child.wait()",
  "os.close(master)",
  "sys.stdout.write(b''.join(chunks).decode(errors='replace'))",
  "sys.exit(status)",
].join("\n");

async function runProcessInTty(repoPath: string, command: string[]) {
  return execFile("python3", ["-c", PTY_SCRIPT, ...command], {
    cwd: repoPath,
    env: {
      ...process.env,
      HOME: repoPath,
      CODEX_HOME: path.join(repoPath, ".codex-home"),
      XDG_CONFIG_HOME: path.join(repoPath, ".xdg"),
      NO_COLOR: "1",
      CI: "false",
    },
    timeout: 30_000,
  });
}

async function runCliInTty(repoPath: string, args: string[]) {
  return runProcessInTty(repoPath, [process.execPath, "--import", tsxLoader, cliPath, ...args]);
}

async function withFakeTty<T>(work: () => Promise<T>): Promise<{ output: string; result: T }> {
  let output = "";
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      output += chunk.toString();
      callback();
    },
  }) as Writable & NodeJS.WriteStream;
  Object.assign(stream, { isTTY: true, columns: 90 });
  const stdout = Object.getOwnPropertyDescriptor(process, "stdout");
  const previousCi = process.env.CI;
  Object.defineProperty(process, "stdout", { configurable: true, writable: true, value: stream });
  process.env.CI = "false";
  try {
    const result = await work();
    return { output, result };
  } finally {
    if (stdout) Object.defineProperty(process, "stdout", stdout);
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
    stream.destroy();
  }
}

async function runCliResult(repoPath: string, args: string[]) {
  try {
    const result = await runCli(repoPath, args);
    return { code: 0, stdout: result.stdout, stderr: result.stderr };
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string };
    return { code: result.code ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

function count(text: string, pattern: RegExp): number {
  return text.match(pattern)?.length ?? 0;
}

test("Clack progress tasks forward title, updates, and percentage changes", async () => {
  const task = createProgressTask("Scanning repository", async (reporter) => {
    reporter.setTitle?.("Parsing repository");
    reporter.update("Found 3 source files");
    await new Promise((resolve) => setTimeout(resolve, 90));
    reporter.setProgress(1, 2);
  }, "graph");
  const messages: string[] = [];
  const completion = await task.task((message) => messages.push(message));

  assert.match(task.title, /Scanning repository/);
  assert.ok(messages.some((message) => /Parsing repository/.test(message)));
  assert.ok(messages.some((message) => /Found 3 source files/.test(message)));
  assert.ok(messages.some((message) => /50%/.test(message)));
  assert.match(completion ?? "", /Parsing repository complete/);
});

function normalizeTerminalOutput(output: string): string {
  const screen = [""];
  let row = 0;
  let column = 0;
  const tokens = output.match(/\u001b\[[0-9;?]*[ -/]*[@-~]|\r|\n|[^\u001b\r\n]/g) ?? [];

  for (const token of tokens) {
    if (token === "\n") {
      row += 1;
      column = 0;
      screen[row] ??= "";
      continue;
    }
    if (token === "\r") {
      column = 0;
      continue;
    }
    if (!token.startsWith("\u001b[")) {
      screen[row] = `${screen[row]!.slice(0, column)}${token}${screen[row]!.slice(column + 1)}`;
      column += 1;
      continue;
    }
    const match = token.match(/\u001b\[([0-9;?]*)([ -/]*)([@-~])/);
    if (!match) continue;
    const value = Number(match[1]?.replace("?", "").split(";")[0] || 1);
    if (match[3] === "A") row = Math.max(0, row - value);
    else if (match[3] === "K") screen[row] = "";
    else if (match[3] === "G") column = Math.max(0, value - 1);
  }

  return screen.filter(Boolean).join("\n");
}

test("init indexes once and installs guidance without a refresh pass", async () => {
  const repoPath = await fixture("init");
  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");
    const result = await runCli(repoPath, ["init"]);
    assert.equal(count(result.stdout, /Refreshing index after guidance update/g), 0);
    assert.ok(count(result.stdout, /Scanning repository/g) < 4);
    assert.match(await readFile(path.join(repoPath, "AGENTS.md"), "utf8"), /sync once against the final tree/);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("TTY progress keeps one final row per phase", async () => {
  const streamResult = await withFakeTty(() => runProgressTasks([
    createProgressTask("Index", async (reporter) => {
      reporter.update("Scanning repository");
      await new Promise((resolve) => setTimeout(resolve, 150));
      reporter.setProgress(1, 1);
      await new Promise((resolve) => setTimeout(resolve, 150));
    }, "graph"),
  ]));
  assert.match(streamResult.output, /Index complete/);
  assert.match(streamResult.output, /100%/);
  // Windows uses the deterministic stream assertion above; Unix also spawns the CLI under a real PTY.
  if (process.platform === "win32") return;
  const repoPath = await fixture("tty");
  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");
    const result = await runCliInTty(repoPath, ["index"]);
    const finalFrame = normalizeTerminalOutput(result.stdout);
    assert.match(finalFrame, /Index complete/);
    assert.equal(count(finalFrame, /100%/g), 0);
    assert.doesNotMatch(finalFrame, /Scanning repository/);
    assert.doesNotMatch(finalFrame, /Hashing files/);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("TTY progress stops its spinner and preserves task failures", async () => {
  const before = Object.fromEntries(["uncaughtExceptionMonitor", "unhandledRejection", "SIGINT", "SIGTERM", "exit"].map((event) => [event, process.listenerCount(event)]));
  const streamResult = await withFakeTty(async () => {
    await assert.rejects(runProgressTasks([
      { title: "Failing task", task: async () => { throw new Error("expected task failure"); } },
    ]), /expected task failure/);
  });
  assert.match(streamResult.output, /expected task failure/);
  for (const [event, count] of Object.entries(before)) assert.equal(process.listenerCount(event), count);
  // Windows asserts Clack's stream cleanup directly; Unix also verifies the child exits under a real PTY.
  if (process.platform === "win32") return;
  const repoPath = await fixture("tty-error");
  try {
    const script = [
      'import { runProgressTasks } from "./src/adapters/cli/cli-progress-reporter.ts";',
      'try { await runProgressTasks([{ title: "Failing task", task: async () => { throw new Error("expected task failure"); } }]); }',
      'catch (error) { console.error(error.message); process.exitCode = 1; }',
    ].join(" ");
    const result = await runProcessInTty(process.cwd(), [
      process.execPath,
      "--import",
      tsxLoader,
      "--input-type=module",
      "-e",
      script,
    ]);
    assert.match(result.stdout, /expected task failure/);
  } catch (error) {
    const result = error as { code?: number; stdout?: string; stderr?: string; killed?: boolean };
    assert.equal(result.killed, false);
    assert.equal(result.code, 1);
    assert.match(result.stdout ?? "", /expected task failure/);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("CI progress stays plain and reports bounded updates", async () => {
  const repoPath = await fixture("ci");
  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");
    const result = await runCli(repoPath, ["index"], { CI: "true" });
    assert.match(result.stdout, /Index complete/);
    assert.ok(count(result.stdout, /Scanning repository/g) <= 2);
    assert.doesNotMatch(result.stdout, /\u001b\[/);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("init reuses the indexing renderer without nesting progress lists", async () => {
  const repoPath = await fixture("init-tty");
  try {
    await writeFile(path.join(repoPath, "source.ts"), "export const value = 1;\n");
    const result = await runCli(repoPath, ["init"], { CI: "false" });
    assert.ok(count(result.stdout, /Indexing repository/g) <= 3);
    assert.match(result.stdout, /Parsing repository|Analyzing repository/);
    assert.match(result.stdout, /Resolving language relationships/);
    assert.match(normalizeTerminalOutput(result.stdout), /Index complete|CodeAtlas initialized/);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("non-TTY progress is plain and bounded", async () => {
  const repoPath = await fixture("plain");
  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");
    const result = await runCli(repoPath, ["index"]);
    assert.doesNotMatch(result.stdout, /\u001b\[/);
    assert.ok(count(result.stdout, /Scanning repository/g) <= 2);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("index and init summaries name real file counts", () => {
  const result = {
    operation: "sync",
    repoPath: "/repo",
    graph: { files: 3, nodes: 8, edges: 9, status: "current", unchangedFiles: 2 },
    lexical: { status: "current" },
    semantic: undefined,
    changes: { addedFiles: ["a.ts"], changedFiles: [], deletedFiles: [] },
    totalMs: 10,
  } as unknown as IndexPipelineResult;
  const indexOutput = formatIndexResult(result);
  assert.match(indexOutput, /Indexed files\s+3/);
  assert.match(indexOutput, /Unchanged\s+2/);
  assert.match(indexOutput, /Changes\s+\+1 added/);

  const initOutput = formatInitResult(
    { repoPath: "/repo", gitRepository: true } as never,
    { repository: { sourceFiles: 4 }, graph: { nodes: 8, edges: 9, status: "ready" }, capabilities: { lexical: { state: "ready" } } } as never,
    true,
    false,
    { totalMs: 10, graph: { files: 4 } },
  );
  assert.match(initOutput, /Source files\s+4/);
  assert.match(initOutput, /Index\s+ready/);
  assert.match(initOutput, /Graph\s+✓ ready/);
  assert.match(initOutput, /Lexical\s+✓ ready/);
});

test("root help is grouped and subcommands stay out of it", () => {
  const help = formatRootHelp();
  for (const heading of ["Repository", "Change Intelligence", "Agents", "Runtime", "Other"]) assert.match(help, new RegExp(heading));
  assert.match(help, /integration\s+Install or inspect agent integrations/);
  assert.doesNotMatch(help, /integration list\|status\|install\|uninstall/);
  assert.match(help, /semantic <setup\|status\|test\|upgrade\|disable\|clean> Manage optional semantic search/);
  assert.match(formatCommandHelp("semantic"), /setup\|status\|test\|upgrade\|disable\|clean/);
  assert.match(formatCommandHelp("status"), /Usage: code-atlas status \[path\]/);
  assert.match(formatCommandHelp("status"), /--json/);
});

test("every top-level command exposes command-specific help", () => {
  for (const command of [
    "init", "index", "sync", "status", "inspect-change", "affected-tests",
    "explain-incomplete", "graph-delta", "architecture-drift", "gate", "connect",
    "disconnect", "integrations", "integration", "hook", "mcp", "serve", "semantic",
  ]) {
    assert.match(formatCommandHelp(command), new RegExp(`Usage: code-atlas ${command}`));
  }
});

test("detailed help exposes the real integration flags", () => {
  assert.match(formatCommandHelp("integration"), /config --format json/);
  assert.match(formatCommandHelp("connect"), /--json/);
  assert.match(formatCommandHelp("disconnect"), /--json/);
  assert.match(formatCommandHelp("integrations"), /--strict/);
  assert.match(formatCommandHelp("integrations"), /--no-guidance/);
});

test("unknown commands remain errors even when help is requested", async () => {
  const repoPath = await fixture("unknown-help");
  try {
    for (const args of [["unknown"], ["unknown", "--help"], ["toString", "--help"]]) {
      const result = await runCliResult(repoPath, args);
      assert.notEqual(result.code, 0, args.join(" "));
      assert.match(result.stderr, /Unknown command/);
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("--help is command-local and does not emit command output", async () => {
  const repoPath = await fixture("help");
  try {
    const result = await runCli(repoPath, ["status", "--help"]);
    assert.match(result.stdout, /Usage: code-atlas status \[path\]/);
    assert.doesNotMatch(result.stdout, /CodeAtlas Status/);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
