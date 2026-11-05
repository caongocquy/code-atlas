import { statSync } from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

function requireProcess(result, command) {
  if (result.error) throw new Error(`Unable to execute ${command}: ${result.error.message}`, { cause: result.error });
  if (result.signal || result.status !== 0) {
    const output = [result.stderr, result.stdout].filter(Boolean).join("\\n").trim();
    throw new Error(`${command} failed with status ${result.status ?? "none"} and signal ${result.signal ?? "none"}${output ? `: ${output}` : ""}`);
  }
}

function findExecutable(env, platform) {
  if (platform === "win32") {
    const where = spawnSync("where.exe", ["pnpm.cmd"], { encoding: "utf8", env, windowsHide: true });
    requireProcess(where, "where.exe pnpm.cmd");
    const executable = where.stdout.split(/\r?\n/).map(value => value.trim()).find(Boolean);
    if (!executable) throw new Error("pnpm.cmd was not found on PATH");
    return executable;
  }
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    const candidate = path.join(directory, "pnpm");
    try {
      if (statSync(candidate).isFile()) return realpathSync(candidate);
    } catch { /* Continue through PATH in order. */ }
  }
  throw new Error("pnpm was not found on PATH");
}

export function readPinnedPnpmVersion(packageManager, env = process.env, platform = process.platform) {
  const match = /^pnpm@(\d+\.\d+\.\d+)$/.exec(packageManager ?? "");
  if (!match) throw new Error("Package manifest must pin pnpm with an exact packageManager version");
  const executable = findExecutable(env, platform);
  const windows = platform === "win32";
  const command = windows ? (env.ComSpec || "cmd.exe") : executable;
  const args = windows ? ["/d", "/c", `call "${executable}" --version`] : ["--version"];
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env,
    windowsHide: true,
    windowsVerbatimArguments: windows
  });
  requireProcess(result, executable);
  const version = result.stdout.trim();
  if (version !== match[1]) throw new Error(`pnpm version mismatch: expected ${match[1]}, received ${version || "no version output"}`);
  return { version, executable };
}
