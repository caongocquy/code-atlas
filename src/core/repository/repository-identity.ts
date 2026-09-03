import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { v5 as uuidv5 } from "uuid";

import { POINT_NAMESPACE } from "../../config/constants.js";

const IDENTITY_FORMAT = "path-v1";

export type RepositoryIdentity = {
  id: string;
  identityKey: string;
  rootPath: string;
  displayName: string;
};

export function canonicalRepositoryPath(repoPath: string): string {
  const absolutePath = path.resolve(repoPath);

  try {
    return path.normalize(fs.realpathSync.native(absolutePath));
  } catch {
    return path.normalize(absolutePath);
  }
}

export function getRepositoryIdentity(repoPath: string): RepositoryIdentity {
  const rootPath = canonicalRepositoryPath(repoPath);
  const normalizedPath = process.platform === "win32" ? rootPath.toLowerCase() : rootPath;
  const identityKey = `${IDENTITY_FORMAT}:${createHash("sha256")
    .update(normalizedPath)
    .digest("hex")}`;

  return {
    id: uuidv5(`code-atlas:${identityKey}`, POINT_NAMESPACE),
    identityKey,
    rootPath,
    displayName: path.basename(rootPath),
  };
}

export function getRepoId(repoPath: string): string {
  return getRepositoryIdentity(repoPath).id;
}
