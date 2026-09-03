import type { AtlasStore } from "../../storage/atlas/atlas.store.js";
import { detectGitChangeCandidates } from "./git-change-detector.js";
import { detectFilesystemChanges } from "./filesystem-change-detector.js";
import type {
  IndexCapability,
  IndexingChanges,
} from "./indexing.types.js";

export type RepositoryChangeDetectorOptions = {
  store: AtlasStore;
  repoId: string;
  capabilities: IndexCapability[];
  versions: Partial<Record<IndexCapability, string>>;
  skipGit?: boolean;
  progress?: Parameters<typeof detectFilesystemChanges>[1]["progress"];
  forceFullScan?: boolean;
};

export async function detectRepositoryChanges(
  repoPath: string,
  options: RepositoryChangeDetectorOptions,
): Promise<IndexingChanges> {
  if (options.skipGit || options.forceFullScan) {
    return detectFilesystemChanges(repoPath, {
      ...options,
      changeDetection: "filesystem",
    });
  }

  const candidates = await detectGitChangeCandidates(repoPath);

  if (candidates === undefined) {
    return detectFilesystemChanges(repoPath, {
      ...options,
      changeDetection: "filesystem",
    });
  }

  return detectFilesystemChanges(repoPath, {
    ...options,
    candidateFiles: candidates,
    changeDetection: "git",
  });
}

export async function detectChangeDetectionMode(
  repoPath: string,
): Promise<"git" | "filesystem"> {
  return (await detectGitChangeCandidates(repoPath)) === undefined
    ? "filesystem"
    : "git";
}
