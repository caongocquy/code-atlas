import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import { resolveRepositoryExcludes } from "../../core/repository/repository-files.js";

export function resolveRepoSourcePath(repoPath: string, requestedPath: string): string {
  const absolutePath = path.resolve(repoPath, requestedPath);
  const relativePath = path.relative(repoPath, absolutePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Source path is outside the repository");
  }

  return absolutePath;
}

export async function readIndexedRepoSource(
  repoPath: string,
  requestedPath: string,
  indexedPaths: ReadonlySet<string>,
): Promise<string> {
  const rootPath = await fs.realpath(path.resolve(repoPath));
  const absolutePath = resolveRepoSourcePath(rootPath, requestedPath);
  const relativePath = path.relative(rootPath, absolutePath).split(path.sep).join("/");
  const name = path.posix.basename(relativePath);

  if (!indexedPaths.has(relativePath)) throw new Error("Source file is not indexed");
  if (/^(?:\.env(?:\.|$)|\.npmrc$|\.netrc$|credentials?(?:[.-]|$)|secrets?(?:[.-]|$)|id_(?:rsa|ed25519)(?:\.|$))/i.test(name)
    || /\.(?:pem|key|p12|pfx)$/i.test(name)) {
    throw new Error("Sensitive source files are not available");
  }

  const excludes = await resolveRepositoryExcludes(rootPath);
  if (excludes.matches(relativePath)) throw new Error("Ignored source files are not available");

  const segments = relativePath.split("/");
  let current = rootPath;
  for (let index = 0; index < segments.length; index += 1) {
    if (current !== rootPath) {
      try {
        await fs.lstat(path.join(current, ".git"));
        throw new Error("Source files inside nested repositories are not available");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    current = path.join(current, segments[index]!);
    const stat = await fs.lstat(current);
    if (stat.isSymbolicLink()) throw new Error("Symbolic links are not available as source");
    if (index < segments.length - 1 && !stat.isDirectory()) throw new Error("Source path is not a directory");
    if (index === segments.length - 1 && !stat.isFile()) throw new Error("Source path is not a regular file");
  }

  const handle = await fs.open(absolutePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    const current = await fs.lstat(absolutePath);
    const canonicalPath = await fs.realpath(absolutePath);
    if (!opened.isFile() || current.isSymbolicLink() || canonicalPath !== absolutePath
      || (opened.ino !== 0 && current.ino !== 0 && (opened.dev !== current.dev || opened.ino !== current.ino))) {
      throw new Error("Source path changed while it was being opened");
    }
    const content = await handle.readFile("utf8");
    const finalPath = await fs.realpath(absolutePath);
    const finalStat = await fs.lstat(absolutePath);
    if (finalPath !== absolutePath || finalStat.isSymbolicLink()
      || (opened.ino !== 0 && finalStat.ino !== 0 && (opened.dev !== finalStat.dev || opened.ino !== finalStat.ino))) {
      throw new Error("Source path changed while it was being read");
    }
    return content;
  } finally {
    await handle.close();
  }
}
