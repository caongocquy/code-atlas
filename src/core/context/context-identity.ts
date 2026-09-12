import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  canonicalRepositoryPath,
  getRepositoryIdentity,
} from "../repository/repository-identity.js";

export type WorkspaceIdentity = {
  repositoryIdentity: string;
  workspaceIdentity: string;
  canonicalPath: string;
  source: "git" | "filesystem";
  gitCommonDirectory?: string;
};

function gitValue(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function getWorkspaceIdentity(inputPath: string): WorkspaceIdentity {
  const canonicalPath = canonicalRepositoryPath(path.resolve(inputPath));
  const gitMarker = path.join(canonicalPath, ".git");
  let isGit = false;
  try {
    isGit = gitValue(canonicalPath, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch (error) {
    if (fs.existsSync(gitMarker)) throw new Error(`Unable to validate Git workspace identity for ${canonicalPath}`, { cause: error });
  }

  if (!isGit) {
    return {
      repositoryIdentity: getRepositoryIdentity(canonicalPath).identityKey,
      workspaceIdentity: `filesystem-v1:${canonicalPath}`,
      canonicalPath,
      source: "filesystem",
    };
  }

  const root = canonicalRepositoryPath(gitValue(canonicalPath, ["rev-parse", "--show-toplevel"]));
  const gitCommonDirectory = canonicalRepositoryPath(gitValue(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  return {
    repositoryIdentity: `git-common-v1:${gitCommonDirectory}`,
    workspaceIdentity: `git-worktree-v1:${canonicalPath}`,
    canonicalPath,
    source: "git",
    gitCommonDirectory,
  };
}
