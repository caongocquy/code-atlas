import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { AtlasStore } from "../../storage/atlas/atlas.store.js";
import { getRepositoryIdentity } from "./repository-identity.js";
import { readTextFile, writeConfigFile } from "../../infrastructure/integration/config-file.js";

const execFile = promisify(execFileCallback);

export type RepositoryInitResult = {
  repoPath: string;
  repoId: string;
  gitRepository: boolean;
  rootGitignoreChanged: boolean;
  indexed: false;
};

export async function initializeRepository(repoPath: string): Promise<RepositoryInitResult> {
  const absolutePath = path.resolve(repoPath);
  const store = new AtlasStore(path.join(absolutePath, ".codeatlas", "atlas.db"));
  const repository = store.ensureRepository(getRepositoryIdentity(absolutePath));
  store.close();

  const gitRepository = await isGitRepository(absolutePath);
  const rootGitignoreChanged = gitRepository ? await ensureRootGitignore(absolutePath) : false;
  return {
    repoPath: absolutePath,
    repoId: repository.id,
    gitRepository,
    rootGitignoreChanged,
    indexed: false,
  };
}

async function isGitRepository(repoPath: string): Promise<boolean> {
  try {
    await execFile("git", ["rev-parse", "--is-inside-work-tree"], { cwd: repoPath });
    return true;
  } catch {
    return false;
  }
}

async function ensureRootGitignore(repoPath: string): Promise<boolean> {
  const file = await readTextFile(path.join(repoPath, ".gitignore"));
  const hasRule = file.text.split(/\r?\n/).some((line) => line.trim() === ".codeatlas/");
  if (hasRule) return false;
  const prefix = file.text.length === 0 ? "" : file.text.endsWith("\n") ? file.text : `${file.text}\n`;
  await writeConfigFile(file, `${prefix}.codeatlas/\n`);
  return true;
}
