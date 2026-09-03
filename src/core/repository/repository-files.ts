import fs from "node:fs/promises";
import path from "node:path";
import { canonicalRepositoryPath } from "./repository-identity.js";

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
  ".codeatlas",
  ".code-rag",
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

    if (entry.isSymbolicLink()) {
      continue;
    }

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
  return (await scanDirectory(path.resolve(repoPath))).sort();
}

export function repositoryRelativePath(
  repoPath: string,
  filePath: string,
): string {
  const rootPath = canonicalRepositoryPath(repoPath);
  const absolutePath = canonicalRepositoryPath(filePath);
  const relativePath = path.relative(rootPath, absolutePath);

  if (
    !relativePath ||
    path.isAbsolute(relativePath) ||
    relativePath === ".." ||
    relativePath.startsWith(`..${path.sep}`)
  ) {
    throw new Error(`File is outside repository root: ${filePath}`);
  }

  return relativePath.split(path.sep).join("/");
}
