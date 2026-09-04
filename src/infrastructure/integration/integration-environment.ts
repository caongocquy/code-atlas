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
  const pathApi = platform === "win32" ? path.win32 : path;
  const env = input.env ?? process.env;
  const home = input.home
    ?? (input.platform === "win32" ? env.USERPROFILE : env.HOME)
    ?? os.homedir();

  return {
    platform,
    home: pathApi.resolve(home),
    cwd: pathApi.resolve(input.cwd ?? process.cwd()),
    env,
  };
}

export async function commandAvailable(
  command: string,
  environment: ResolvedIntegrationEnvironment,
): Promise<boolean> {
  const pathValue = environment.env.PATH ?? "";
  const pathApi = environment.platform === "win32" ? path.win32 : path;
  const candidates = pathValue.split(path.delimiter).filter(Boolean);
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
