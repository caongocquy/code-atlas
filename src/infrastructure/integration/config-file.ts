import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

export class ConfigParseError extends Error {
  constructor(
    readonly configPath: string,
    summary: string,
  ) {
    super(`Malformed configuration at ${configPath}: ${summary}`);
  }
}

export type ConfigFile = {
  path: string;
  writePath: string;
  exists: boolean;
  text: string;
  mode?: number;
};

export async function readConfigFile(configPath: string): Promise<ConfigFile> {
  const absolutePath = path.resolve(configPath);
  let linkPath: string | undefined;

  try {
    const linkStat = await fs.lstat(absolutePath);
    linkPath = linkStat.isSymbolicLink() ? absolutePath : undefined;
    const writePath = linkStat.isSymbolicLink()
      ? await fs.realpath(absolutePath)
      : absolutePath;
    const stat = await fs.stat(absolutePath);
    return {
      path: absolutePath,
      writePath,
      exists: true,
      text: await fs.readFile(absolutePath, "utf8"),
      mode: stat.mode & 0o777,
    };
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      if (linkPath) {
        throw new Error(`Refusing to replace broken symlink configuration at ${linkPath}`, { cause: error });
      }
      return { path: absolutePath, writePath: absolutePath, exists: false, text: "" };
    }
    throw error;
  }
}

export async function writeConfigFile(
  file: ConfigFile,
  text: string,
): Promise<void> {
  await fs.mkdir(path.dirname(file.writePath), { recursive: true });
  const temporaryPath = path.join(
    path.dirname(file.writePath),
    `.${path.basename(file.writePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );

  try {
    await fs.writeFile(temporaryPath, text, {
      encoding: "utf8",
      mode: file.mode ?? 0o600,
    });
    if (file.mode !== undefined) await fs.chmod(temporaryPath, file.mode);
    await fs.rename(temporaryPath, file.writePath);
  } catch (error) {
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export async function readTextFile(filePath: string): Promise<ConfigFile> {
  return readConfigFile(filePath);
}
