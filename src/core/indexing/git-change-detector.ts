import { execFile } from "node:child_process";
import { promisify } from "node:util";
import path from "node:path";

import {
  canonicalRepositoryPath,
} from "../repository/repository-identity.js";

const execFileAsync = promisify(execFile);
const excludedDirectories = [
  ".git",
  ".codeatlas",
  ".code-rag",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".dart_tool",
  "Pods",
];

async function gitOutput(repoPath: string, args: string[]): Promise<string> {
  const result = await execFileAsync("git", args, {
    cwd: repoPath,
    encoding: "utf8",
    maxBuffer: 4 * 1024 * 1024,
  });

  return String(result.stdout);
}

function statusPath(record: string): string | undefined {
  if (record.length >= 3 && record[2] === " ") {
    return record.slice(3);
  }

  return record || undefined;
}

export async function detectGitChangeCandidates(
  repoPath: string,
): Promise<Set<string> | undefined> {
  try {
    const requestedRoot = canonicalRepositoryPath(repoPath);
    const gitRoot = canonicalRepositoryPath(
      (await gitOutput(requestedRoot, ["rev-parse", "--show-toplevel"])).trim(),
    );

    if (gitRoot !== requestedRoot) {
      return undefined;
    }

    const status = await gitOutput(requestedRoot, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--ignored=matching",
    ]);
    const candidates = new Set<string>();

    for (const record of status.split("\0")) {
      const candidate = statusPath(record);

      if (!candidate) {
        continue;
      }

      const absolutePath = path.resolve(requestedRoot, candidate);
      const relativePath = path.relative(requestedRoot, absolutePath);

      if (excludedDirectories.some((directory) =>
        relativePath === directory || relativePath.startsWith(`${directory}${path.sep}`))) {
        continue;
      }

      if (candidate.endsWith("/")) {
        return undefined;
      }

      if (
        relativePath &&
        !path.isAbsolute(relativePath) &&
        relativePath !== ".." &&
        !relativePath.startsWith(`..${path.sep}`)
      ) {
        candidates.add(relativePath.split(path.sep).join("/"));
      }
    }

    return candidates;
  } catch {
    return undefined;
  }
}
