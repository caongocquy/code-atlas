import fs from "node:fs/promises";
import path from "node:path";

import type { AtlasCapability, AtlasFileCapabilityState } from "../../storage/atlas/atlas.types.js";
import type { AtlasStore } from "../../storage/atlas/atlas.store.js";
import type { ProgressRunner } from "../progress/progress.types.js";
import { createFileHash } from "../repository/file-hash.js";
import type { FactExtractionOutcome } from "../facts/facts-extractor.js";
import type { ParsedFactsBlob } from "../facts/facts.types.js";
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

const MODULE_CONFIG_FILENAMES = new Set(["package.json", "tsconfig.json", "jsconfig.json"]);

export function isModuleConfigPath(relativePath: string): boolean {
  return MODULE_CONFIG_FILENAMES.has(path.posix.basename(relativePath));
}

async function moduleConfigPaths(repoPath: string, persistedFiles: ReadonlySet<string>): Promise<string[]> {
  const paths = new Set([...persistedFiles].filter(isModuleConfigPath));
  for (const file of MODULE_CONFIG_FILENAMES) {
    try {
      if ((await fs.stat(path.join(repoPath, file))).isFile()) paths.add(file);
    } catch {
      // Missing config files are handled through the persisted path set.
    }
  }
  return [...paths].sort();
}

export type SourceRead = { source: string; contentHash: string };
export type SourceReader = (relativePath: string) => Promise<SourceRead>;
export type StableFactExtraction = { source: string; facts: ParsedFactsBlob };

export class SourceRaceError extends Error {
  constructor(relativePath: string) {
    super(`Source changed during fact extraction: ${relativePath}`);
    this.name = "SourceRaceError";
  }
}

export async function extractStableFacts(
  relativePath: string,
  reader: SourceReader,
  extractor: (read: SourceRead) => FactExtractionOutcome,
  maxAttempts = 2,
): Promise<StableFactExtraction> {
  const attempts = Math.min(2, Math.max(1, maxAttempts));

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    const before = await reader(relativePath);
    const extracted = extractor(before);
    if (extracted.kind !== "facts") throw extracted.error;
    const after = await reader(relativePath);

    if (before.contentHash === after.contentHash) {
      return { source: before.source, facts: extracted.facts };
    }
  }

  throw new SourceRaceError(relativePath);
}

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
  const configPaths = await moduleConfigPaths(repoPath, persistedFiles);
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

  for (const relativeFile of configPaths) {
    try {
      fileHashes.set(relativeFile, createFileHash(await fs.readFile(path.join(repoPath, relativeFile), "utf8")));
      currentFiles.add(relativeFile);
    } catch {
      // A removed config is reported from persistedFiles below.
    }
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
  for (const relativeFile of configPaths) {
    const hash = fileHashes.get(relativeFile);
    const state = states.get("graph")?.get(relativeFile);
    const needsIndex = hash !== undefined && stateNeedsIndex(state, undefined, "graph", options.versions.graph, hash);
    if (needsIndex) candidateFiles.add(relativeFile);
    if (!persistedFiles.has(relativeFile)) addedFiles.push(relativeFile);
    else if (needsIndex) changedFiles.push(relativeFile);
  }
  const moduleConfigChanged = configPaths.some((file) =>
    (fileHashes.has(file) && candidateFiles.has(file)) || deletedFiles.includes(file),
  );

  return {
    changeDetection: options.changeDetection ?? "filesystem",
    files,
    relativeFiles,
    candidateFiles: Array.from(candidateFiles).sort(),
    fileHashes,
    addedFiles: addedFiles.sort(),
    changedFiles: changedFiles.sort(),
    deletedFiles,
    ...(moduleConfigChanged ? { moduleConfigChanged: true } : {}),
  };
}
