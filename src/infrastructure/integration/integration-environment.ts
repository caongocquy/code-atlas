import os from "node:os";
import { stat } from "node:fs/promises";
import path from "node:path";

export type IntegrationEnvironment = {
  platform?: NodeJS.Platform;
  home?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
};

export type ResolvedIntegrationEnvironment = {
  platform: NodeJS.Platform;
  home: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
};

export function resolveIntegrationEnvironment(
  input: IntegrationEnvironment = {},
): ResolvedIntegrationEnvironment {
  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const home = input.home
    ?? (platform === "win32" ? env.USERPROFILE : env.HOME)
    ?? os.homedir();
  const cwd = input.cwd ?? process.cwd();
  const pathApi = integrationPathApi({ platform, home, cwd });

  return {
    platform,
    home: pathApi.resolve(home),
    cwd: pathApi.resolve(cwd),
    env,
  };
}

// Pure platform simulations must not inherit the host's path syntax. Retain native
// Windows paths for host-backed fixtures that inject Linux integration behavior.
export function integrationPathApi(environment: Pick<ResolvedIntegrationEnvironment, "platform" | "home" | "cwd">) {
  if (environment.platform === "win32") return path.win32;
  const nativeWindowsPath = (value: string) => path.win32.isAbsolute(value) && !path.posix.isAbsolute(value);
  if (process.platform === "win32" && nativeWindowsPath(environment.home) && nativeWindowsPath(environment.cwd)) {
    return path.win32;
  }
  return path.posix;
}

export async function commandAvailable(
  command: string,
  environment: ResolvedIntegrationEnvironment,
): Promise<boolean> {
  const pathValue = environment.env.PATH ?? "";
  const pathApi = integrationPathApi(environment);
  const candidates = pathValue.split(pathApi.delimiter).filter(Boolean);
  const names = environment.platform === "win32"
    ? [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]
    : [command];

  for (const directory of candidates) {
    for (const name of names) {
      try {
        const result = await stat(pathApi.join(directory, name));
        if (result.isFile()) return true;
      } catch {
        // Continue scanning PATH entries.
      }
    }
  }

  return false;
}
