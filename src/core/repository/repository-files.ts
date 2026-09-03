import fs from "node:fs/promises";
import path from "node:path";

export { getRepoId } from "./repository-identity.js";

const allowedExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".dart",
  ".py",
  ".md",
]);

const ignoredDirectories = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  ".next",
  ".dart_tool",
  "Pods",
]);

async function scanDirectory(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, {
    withFileTypes: true,
  });

  const files: string[] = [];

  for (const entry of entries) {
    const fullPath = path.join(directory, entry.name);

    if (entry.isDirectory()) {
      if (ignoredDirectories.has(entry.name)) {
        continue;
      }

      files.push(...(await scanDirectory(fullPath)));

      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    if (!allowedExtensions.has(path.extname(entry.name))) {
      continue;
    }

    files.push(fullPath);
  }

  return files;
}

export async function scanRepo(repoPath: string): Promise<string[]> {
  return scanDirectory(path.resolve(repoPath));
}
