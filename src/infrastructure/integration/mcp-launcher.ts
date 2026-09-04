import { stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import type { DurableMcpLaunch } from "../../core/integration/integration.types.js";

export async function resolveDurableMcpLaunch(
  moduleUrl = import.meta.url,
): Promise<DurableMcpLaunch> {
  const command = process.execPath;
  const packageRoot = path.resolve(path.dirname(fileURLToPath(moduleUrl)), "../../..");
  const cliPath = path.join(packageRoot, "dist", "cli.js");
  if (!path.isAbsolute(command) || !isNodeExecutable(command) || !await isFile(command)) {
    throw new Error(`Node executable is not available at an absolute path: ${command}`);
  }
  if (isEphemeralMcpPath(command) || isEphemeralMcpPath(cliPath)) {
    throw new Error(`CodeAtlas must be installed durably before configuring an agent; ephemeral installation at ${cliPath}; install CodeAtlas durably before retrying.`);
  }
  if (!await isFile(cliPath)) {
    throw new Error(`Compiled CodeAtlas CLI is not available at ${cliPath}; build the package before configuring an agent.`);
  }
  return { command, args: [cliPath, "mcp"] };
}

export async function validateConfiguredLaunch(
  launch: DurableMcpLaunch,
): Promise<"valid" | "stale" | "ephemeral"> {
  if (typeof launch?.command !== "string" || !Array.isArray(launch.args)) return "stale";
  const cliPath = launch.args[0];
  if (isEphemeralMcpPath(launch.command) || typeof cliPath === "string" && isEphemeralMcpPath(cliPath)) return "ephemeral";
  if (!path.isAbsolute(launch.command)
    || !isNodeExecutable(launch.command)
    || launch.args.length !== 2
    || !path.isAbsolute(cliPath ?? "")
    || launch.args[1] !== "mcp") return "stale";
  return await isFile(launch.command) && await isFile(cliPath) ? "valid" : "stale";
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

async function isFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}
