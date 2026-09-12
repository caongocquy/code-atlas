import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DurableMcpLaunch } from "../../core/integration/integration.types.js";

type LauncherOptions = { argv?: string[]; env?: NodeJS.ProcessEnv };

export async function resolveDurableMcpLaunch(
  moduleUrl = import.meta.url,
  options: LauncherOptions = {},
): Promise<DurableMcpLaunch> {
  const modulePath = fileURLToPath(moduleUrl);
  if (isEphemeralMcpPath(modulePath)) {
    throw new Error(`CodeAtlas must be installed durably before configuring an agent; ephemeral installation at ${modulePath}; install CodeAtlas durably before retrying.`);
  }
  const argv = options.argv ?? process.argv;
  const env = options.env ?? process.env;
  const invokedPath = argv[1];
  const candidates = invokedPath && path.isAbsolute(invokedPath) && isCodeAtlasExecutablePath(invokedPath)
    ? [invokedPath]
    : resolvePathCandidates(env.PATH);
  for (const candidate of candidates) {
    if (!isEphemeralMcpPath(candidate) && await isExecutableFile(candidate)) {
      return { command: candidate, args: ["mcp"] };
    }
  }
  throw new Error("CodeAtlas must be installed durably before configuring an agent; resolve an absolute `code-atlas` executable and retry.");
}

export async function validateConfiguredLaunch(
  launch: DurableMcpLaunch,
): Promise<"valid" | "stale" | "ephemeral"> {
  if (typeof launch?.command !== "string" || !Array.isArray(launch.args)) return "stale";
  const cliPath = launch.args[0];
  if (isEphemeralMcpPath(launch.command) || launch.args.some((arg) => typeof arg === "string" && isEphemeralMcpPath(arg))) return "ephemeral";
  if (!path.isAbsolute(launch.command)) return "stale";
  if (launch.args.length === 1 && launch.args[0] === "mcp") {
    return isCodeAtlasExecutablePath(launch.command) && await isExecutableFile(launch.command) ? "valid" : "stale";
  }
  if (launch.args.length === 2 && path.isAbsolute(cliPath ?? "") && launch.args[1] === "mcp") {
    return isNodeExecutable(launch.command) && await isExecutableFile(launch.command) && await isFile(cliPath!) ? "valid" : "stale";
  }
  return "stale";
}

export function configuredMcpLaunch(command: string, args: string[]): DurableMcpLaunch | undefined {
  if (!path.isAbsolute(command) || args[args.length - 1] !== "mcp") return undefined;
  if (args.length === 1 || args.length === 2 && path.isAbsolute(args[0]!)) return { command, args };
  return undefined;
}

export function isEphemeralMcpPath(filePath: string): boolean {
  const absolutePath = path.resolve(filePath);
  const temporaryRoot = path.resolve(tmpdir());
  const temporaryRoots = [temporaryRoot];
  if (process.platform !== "win32") temporaryRoots.push("/tmp", "/private/tmp");
  if (process.platform === "darwin") {
    temporaryRoots.push("/var/folders", "/private/var/folders");
    if (temporaryRoot.startsWith("/var/")) temporaryRoots.push(path.join("/private", temporaryRoot.slice(1)));
  }
  if (temporaryRoots.some((root) => {
    const relative = path.relative(path.resolve(root), absolutePath);
    return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
  })) return true;
  const segments = absolutePath.split(path.sep).filter(Boolean).map((segment) => segment.toLowerCase());
  return segments.includes("npx") || segments.includes("_npx") || segments.includes(".npx") || segments.includes("dlx");
}

function isNodeExecutable(command: string): boolean {
  const name = path.basename(command).toLowerCase();
  return name === "node" || name === "node.exe" || name === "nodejs";
}

function resolvePathCandidates(pathValue: string | undefined): string[] {
  return (pathValue ?? "").split(path.delimiter).filter(Boolean).map((directory) => path.resolve(directory, "code-atlas"));
}

function isCodeAtlasExecutablePath(filePath: string): boolean {
  const name = path.basename(filePath).toLowerCase();
  return name === "code-atlas" || name === "code-atlas.cmd" || name === "code-atlas.exe";
}

async function isExecutableFile(filePath: string): Promise<boolean> {
  try {
    const details = await stat(filePath);
    return details.isFile() && (process.platform === "win32" || (details.mode & 0o111) !== 0);
  } catch {
    return false;
  }
}

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}
