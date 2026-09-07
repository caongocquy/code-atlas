import fs from "node:fs/promises";
import path from "node:path";

import type { AtlasCapability, AtlasFileCapabilityState } from "../../storage/atlas/atlas.types.js";
import type { AtlasStore } from "../../storage/atlas/atlas.store.js";
import type { ProgressRunner } from "../progress/progress.types.js";
import { createFileHash } from "../repository/file-hash.js";
import {
  repositoryRelativePath,
  scanRepo,
} from "../repository/repository-files.js";
import type {
  ChangeDetectionMode,
  IndexCapability,
  IndexingChanges,
} from "./indexing.types.js";

export type ChangeDetectorOptions = {
  store: AtlasStore;
  repoId: string;
  capabilities: IndexCapability[];
  versions: Partial<Record<IndexCapability, string>>;
  candidateFiles?: Set<string>;
  progress?: ProgressRunner;
  changeDetection?: ChangeDetectionMode;
  forceFullScan?: boolean;
};

type FileStates = Map<IndexCapability, Map<string, AtlasFileCapabilityState>>;

function statesByCapability(
  store: AtlasStore,
  repoId: string,
  capabilities: IndexCapability[],
): FileStates {
  return new Map(
    capabilities.map((capability) => [
      capability,
      store.getFileCapabilityStates(repoId, capability as AtlasCapability),
    ]),
  );
}

function stateNeedsIndex(
  state: AtlasFileCapabilityState | undefined,
  binding: { contentHash: string; language: string } | undefined,
  capability: IndexCapability,
  version: string | undefined,
  fileHash: string | undefined,
): boolean {
  if (!state && binding?.contentHash === fileHash) return false;
  if (!state || state.state !== "ready" || state.version !== version) {
    return true;
  }

  return fileHash !== undefined && state.fileHash !== fileHash;
}

async function scanFiles(
  repoPath: string,
  progress: ChangeDetectorOptions["progress"],
): Promise<string[]> {
  if (!progress) {
    return scanRepo(repoPath);
  }

  return progress.run("Scanning repository", async (reporter) => {
    const files = await scanRepo(repoPath);
    reporter.update(`${files.length} found`);
    return files;
  });
}

export async function detectFilesystemChanges(
  repoPath: string,
  options: ChangeDetectorOptions,
): Promise<IndexingChanges> {
  const files = await scanFiles(repoPath, options.progress);
  const relativeFiles = files.map((file) => repositoryRelativePath(repoPath, file));
  const currentFiles = new Set(relativeFiles);
  const persistedFiles = options.store.getIndexedFilePaths(options.repoId);
  const states = statesByCapability(options.store, options.repoId, options.capabilities);
  const activeBindings = new Map(
    options.store.getGenerationManifest(options.repoId)?.files.map((file) => [file.relativePath, file]) ?? [],
  );
  const candidateHint = options.candidateFiles;
  // The unified pipeline needs hashes for every current file to materialize
  // generation bindings and distinguish fact reuse from a parser miss.
  const shouldHashAll = true;
  const fileHashes = new Map<string, string>();

  const hashes = async (reporter: { setProgress(current: number, total: number): void }) => {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const relativeFile = relativeFiles[index];

      if (!file || !relativeFile) {
        continue;
      }

      const shouldHash = shouldHashAll || candidateHint?.has(relativeFile) === true;

      if (shouldHash) {
        fileHashes.set(relativeFile, createFileHash(await fs.readFile(file, "utf8")));
      }

      reporter.setProgress(index + 1, files.length);
    }
  };

  if (options.progress) {
    await options.progress.run("Hashing files", hashes, "graph");
  } else {
    await hashes({ setProgress() {} });
  }

  const candidateFiles = new Set<string>();
  const addedFiles: string[] = [];
  const changedFiles: string[] = [];

  for (const relativeFile of relativeFiles) {
    const hash = fileHashes.get(relativeFile);
    const persisted = persistedFiles.has(relativeFile);
    const needsIndex = options.forceFullScan || options.capabilities.some((capability) =>
      stateNeedsIndex(
        states.get(capability)?.get(relativeFile),
        capability === "graph" || capability === "lexical" ? activeBindings.get(relativeFile) : undefined,
        capability,
        options.versions[capability],
        hash,
      ),
    );

    if (needsIndex) {
      candidateFiles.add(relativeFile);
    }

    if (!persisted) {
      addedFiles.push(relativeFile);
    } else if (needsIndex) {
      changedFiles.push(relativeFile);
    }
  }

  const deletedFiles = Array.from(persistedFiles)
    .filter((file) => !currentFiles.has(file))
    .sort();

  return {
    changeDetection: options.changeDetection ?? "filesystem",
    files,
    relativeFiles,
    candidateFiles: Array.from(candidateFiles).sort(),
    fileHashes,
    addedFiles: addedFiles.sort(),
    changedFiles: changedFiles.sort(),
    deletedFiles,
  };
}
