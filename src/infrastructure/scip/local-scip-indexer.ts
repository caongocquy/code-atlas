import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";

import type { IndexedSourceUnit } from "../../core/indexing/indexing.types.js";
import type { ScipDiscovery, ScipIndexer, ScipTool } from "../../core/indexing/scip-indexer.types.js";
import { normalizeScipIndex } from "../../core/indexing/scip-normalizer.js";

const MAX_PROCESS_OUTPUT_BYTES = 1024 * 1024;
const MAX_SCIP_INDEX_BYTES = 256 * 1024 * 1024;
const VERSION_TIMEOUT_MS = 5_000;
const INDEX_TIMEOUT_MS = 5 * 60 * 1000;

type LocalScipIndexerOptions = {
  env?: NodeJS.ProcessEnv;
  maxProcessOutputBytes?: number;
  maxScipIndexBytes?: number;
  versionTimeoutMs?: number;
  indexTimeoutMs?: number;
};

type ProcessResult = { stdout: string; stderr: string };

function commandCandidates(projectRoot: string, env: NodeJS.ProcessEnv): Array<{ path: string; source: ScipTool["source"] }> {
  const executable = process.platform === "win32" ? "scip-typescript.cmd" : "scip-typescript";
  const candidates: Array<{ path: string; source: ScipTool["source"] }> = [
    { path: path.join(projectRoot, "node_modules", ".bin", executable), source: "project-local" },
  ];
  for (const directory of (env.PATH ?? "").split(path.delimiter).filter(Boolean)) {
    candidates.push({ path: path.resolve(projectRoot, directory, executable), source: "path" });
  }
  return candidates;
}

async function executable(file: string): Promise<boolean> {
  try {
    const info = await fs.stat(file);
    if (!info.isFile()) return false;
    if (process.platform === "win32") return true;
    await fs.access(file, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

async function windowsNodeEntryPoint(shimPath: string): Promise<string | undefined> {
  const shim = await fs.readFile(shimPath, "utf8");
  const match = shim.match(/"%~?dp0%[\\/]([^"]+\.js)"/i);
  if (!match?.[1]) return undefined;
  const entryPoint = path.resolve(path.dirname(shimPath), match[1].replace(/[\\/]/g, path.sep));
  try {
    if (!(await fs.stat(entryPoint)).isFile()) return undefined;
    return await fs.realpath(entryPoint);
  } catch {
    return undefined;
  }
}

function runTool(
  tool: ScipTool,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number },
): Promise<ProcessResult> {
  return runProcess(
    tool.nodeEntryPoint ? process.execPath : tool.executablePath,
    [...(tool.nodeEntryPoint ? [tool.nodeEntryPoint] : []), ...args],
    options,
  );
}

function runProcess(
  command: string,
  args: readonly string[],
  options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number; maxOutputBytes: number },
): Promise<ProcessResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let stderr: Buffer<ArrayBufferLike> = Buffer.alloc(0);
    let outputBytes = 0;
    let settled = false;
    const finish = (error?: Error, result?: ProcessResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(result!);
    };
    const append = (current: Buffer<ArrayBufferLike>, chunk: Buffer, channel: "stdout" | "stderr"): Buffer<ArrayBufferLike> => {
      outputBytes += chunk.byteLength;
      if (outputBytes > options.maxOutputBytes) {
        child.kill("SIGKILL");
        finish(new Error(`scip-typescript ${channel} exceeded ${options.maxOutputBytes} bytes`));
        return current;
      }
      return Buffer.concat([current, chunk]);
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(new Error(`scip-typescript timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout = append(stdout, chunk, "stdout"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr = append(stderr, chunk, "stderr"); });
    child.once("error", (error) => finish(new Error(`scip-typescript could not start: ${error.message}`)));
    child.once("close", (code, signal) => {
      if (code !== 0) {
        const details = stderr.toString("utf8").trim().slice(-2_000);
        finish(new Error(`scip-typescript exited with ${signal ?? code}${details ? `: ${details}` : ""}`));
        return;
      }
      finish(undefined, { stdout: stdout.toString("utf8"), stderr: stderr.toString("utf8") });
    });
  });
}

async function workspaceArguments(projectRoot: string): Promise<string[]> {
  try {
    await fs.access(path.join(projectRoot, "pnpm-workspace.yaml"));
    return ["--pnpm-workspaces"];
  } catch {
    return [];
  }
}

export class LocalScipIndexer implements ScipIndexer {
  private readonly env: NodeJS.ProcessEnv;
  private readonly maxProcessOutputBytes: number;
  private readonly maxScipIndexBytes: number;
  private readonly versionTimeoutMs: number;
  private readonly indexTimeoutMs: number;

  constructor(options: LocalScipIndexerOptions = {}) {
    this.env = options.env ?? process.env;
    this.maxProcessOutputBytes = options.maxProcessOutputBytes ?? MAX_PROCESS_OUTPUT_BYTES;
    this.maxScipIndexBytes = options.maxScipIndexBytes ?? MAX_SCIP_INDEX_BYTES;
    this.versionTimeoutMs = options.versionTimeoutMs ?? VERSION_TIMEOUT_MS;
    this.indexTimeoutMs = options.indexTimeoutMs ?? INDEX_TIMEOUT_MS;
  }

  async discover(projectRoot: string): Promise<ScipDiscovery> {
    let found: { path: string; source: ScipTool["source"] } | undefined;
    for (const candidate of commandCandidates(projectRoot, this.env)) {
      if (await executable(candidate.path)) {
        found = candidate;
        break;
      }
    }
    if (!found) return { status: "unavailable" };
    try {
      const executablePath = await fs.realpath(found.path);
      const nodeEntryPoint = process.platform === "win32" ? await windowsNodeEntryPoint(executablePath) : undefined;
      if (process.platform === "win32" && !nodeEntryPoint) {
        return { status: "failed", diagnostic: `could not resolve a JavaScript entry point from ${executablePath}` };
      }
      const tool: ScipTool = {
        executablePath,
        ...(nodeEntryPoint ? { nodeEntryPoint } : {}),
        source: found.source,
        version: "",
      };
      const result = await runTool(tool, ["--version"], {
        cwd: projectRoot,
        env: this.env,
        timeoutMs: this.versionTimeoutMs,
        maxOutputBytes: this.maxProcessOutputBytes,
      });
      const version = result.stdout.trim().split(/\r?\n/, 1)[0]?.trim();
      if (!version) return { status: "failed", diagnostic: "scip-typescript --version returned no version" };
      return { status: "ready", tool: { ...tool, version } };
    } catch (error) {
      return { status: "failed", diagnostic: error instanceof Error ? error.message : String(error) };
    }
  }

  async index(input: { projectRoot: string; repositoryId: string; tool: ScipTool; units: readonly IndexedSourceUnit[] }) {
    const tempRoot = await fs.mkdtemp(path.join(tmpdir(), "code-atlas-scip-"));
    const outputPath = path.join(tempRoot, "index.scip");
    try {
      const args = ["index", "--cwd", input.projectRoot, "--output", outputPath];
      const hasConfig = await Promise.all(["tsconfig.json", "jsconfig.json"].map((file) =>
        fs.access(path.join(input.projectRoot, file)).then(() => true, () => false),
      )).then((values) => values.some(Boolean));
      if (!hasConfig && input.units.some((unit) => unit.facts.language === "javascript")) args.push("--infer-tsconfig");
      args.push(...await workspaceArguments(input.projectRoot));
      await runTool(input.tool, args, {
        cwd: input.projectRoot,
        env: this.env,
        timeoutMs: this.indexTimeoutMs,
        maxOutputBytes: this.maxProcessOutputBytes,
      });
      const outputStat = await fs.stat(outputPath);
      if (!outputStat.isFile() || outputStat.size === 0) throw new Error("scip-typescript did not produce an index.scip artifact");
      if (outputStat.size > this.maxScipIndexBytes) throw new Error(`SCIP index exceeded ${this.maxScipIndexBytes} bytes`);
      const index = await fs.readFile(outputPath);
      return normalizeScipIndex(index, { repositoryId: input.repositoryId, units: input.units });
    } finally {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }
}

export const localScipIndexer = new LocalScipIndexer();
