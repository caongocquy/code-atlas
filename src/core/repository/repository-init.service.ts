import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { AtlasStore } from "../../storage/atlas/atlas.store.js";
import { getRepositoryIdentity } from "./repository-identity.js";

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
  return {
    repoPath: absolutePath,
    repoId: repository.id,
    gitRepository,
    rootGitignoreChanged: false,
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
