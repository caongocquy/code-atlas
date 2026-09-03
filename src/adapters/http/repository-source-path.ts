import path from "node:path";

export function resolveRepoSourcePath(repoPath: string, requestedPath: string): string {
  const absolutePath = path.resolve(repoPath, requestedPath);
  const relativePath = path.relative(repoPath, absolutePath);

  if (relativePath.startsWith("..") || path.isAbsolute(relativePath)) {
    throw new Error("Source path is outside the repository");
  }

  return absolutePath;
}
