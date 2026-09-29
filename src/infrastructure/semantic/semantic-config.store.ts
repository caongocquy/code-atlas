import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { parseCodeAtlasRepositoryConfig, type CodeAtlasRepositoryConfig } from "../../core/config/codeatlas-config.js";
import { canonicalRepositoryPath } from "../../core/repository/repository-identity.js";

async function configPathFor(repoPath: string): Promise<string> {
  const root = canonicalRepositoryPath(path.resolve(repoPath));
  const configPath = path.join(root, "codeatlas.config.json");
  try {
    const target = await fs.realpath(configPath);
    const relative = path.relative(root, target);
    if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("codeatlas.config.json must stay inside the repository.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return configPath;
}

export async function readRepositoryConfig(repoPath: string): Promise<CodeAtlasRepositoryConfig> {
  const configPath = await configPathFor(repoPath);
  let raw: string;
  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { version: 1 };
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error("codeatlas.config.json must contain valid JSON.", { cause });
  }
  return parseCodeAtlasRepositoryConfig(parsed);
}

export async function writeRepositoryConfig(repoPath: string, input: CodeAtlasRepositoryConfig): Promise<void> {
  const configPath = await configPathFor(repoPath);
  const config = parseCodeAtlasRepositoryConfig(input);
  const temporaryPath = `${configPath}.${randomUUID()}.tmp`;
  try {
    await writeAtomically(configPath, `${JSON.stringify(config, null, 2)}\n`, temporaryPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

export async function ensureEnvExampleVariable(repoPath: string, name: string): Promise<void> {
  const root = canonicalRepositoryPath(path.resolve(repoPath));
  const filePath = path.join(root, ".env.example");
  let content = "";
  try {
    if ((await fs.lstat(filePath)).isSymbolicLink()) throw new Error(".env.example must not be a symbolic link.");
    content = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (content.split(/\r?\n/).some((line) => line.startsWith(`${name}=`))) return;
  const prefix = content && !content.endsWith("\n") ? "\n" : "";
  const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
  try {
    await writeAtomically(filePath, `${content}${prefix}${name}=\n`, temporaryPath);
  } finally {
    await fs.rm(temporaryPath, { force: true });
  }
}

async function writeAtomically(destination: string, content: string, temporaryPath: string): Promise<void> {
  await fs.writeFile(temporaryPath, content, { flag: "wx" });
  await fs.rename(temporaryPath, destination);
}
