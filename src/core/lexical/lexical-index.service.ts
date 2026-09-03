import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";

import type { ProgressReporter, ProgressRunner } from "../progress/progress.types.js";
import { LEXICAL_INDEX_VERSION } from "../../config/constants.js";
import { AtlasStore } from "../../storage/atlas/atlas.store.js";
import type { LexicalDocument, LexicalFileUpdate } from "../../storage/atlas/atlas.types.js";
import { parseCodeSymbols } from "../graph/parsers/code-parser.js";
import type { CodeChunk } from "../graph/parsers/types.js";
import { createFileHash } from "../repository/file-hash.js";
import { getRepositoryIdentity } from "../repository/repository-identity.js";
import { scanRepo } from "../repository/repository-files.js";
import { splitLargeSymbol } from "../semantic/split-symbol.js";
import { silentProgressRunner } from "../progress/silent-progress-runner.js";

export type LexicalIndexOptions = { progress?: ProgressRunner };

export type LexicalIndexResult = {
  repoPath: string;
  repoId: string;
  status: "indexed" | "current";
  storedVersion?: string;
  version: string;
  versionChanged: boolean;
  fullRebuild: boolean;
  files: number;
  indexedFiles: number;
  skippedFiles: number;
  deletedFiles: number;
  documents: number;
  totalMs: number;
};

function searchableIdentifier(value: string): string {
  const parts = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);

  return [value, ...parts].join(" ");
}

function documentId(repoId: string, file: string, chunk: CodeChunk, index: number): string {
  return createHash("sha256")
    .update([
      repoId, file, chunk.symbolType, chunk.symbolName, chunk.startLine,
      chunk.endLine, chunk.part ?? 1, index,
    ].join("\0"))
    .digest("hex");
}

function toDocuments(repoId: string, file: string, chunks: CodeChunk[]): LexicalDocument[] {
  return chunks.map((chunk, index) => ({
    documentId: documentId(repoId, file, chunk, index),
    file,
    symbolName: searchableIdentifier(chunk.symbolName),
    qualifiedName: searchableIdentifier(chunk.symbolName),
    symbolType: chunk.symbolType,
    content: chunk.content,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
  }));
}

async function createUpdates(
  repoPath: string,
  repoId: string,
  files: string[],
  reporter: ProgressReporter,
): Promise<LexicalFileUpdate[]> {
  const updates: LexicalFileUpdate[] = [];

  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    if (!file) continue;

    const relativePath = path.relative(repoPath, file);
    const content = await fs.readFile(file, "utf8");
    const chunks = parseCodeSymbols(content, relativePath).flatMap(splitLargeSymbol);
    updates.push({
      file: relativePath,
      fileHash: createFileHash(content),
      documents: toDocuments(repoId, relativePath, chunks),
    });
    reporter.setProgress(index + 1, files.length);
  }

  return updates;
}

export async function indexLexical(
  inputPath: string,
  options: LexicalIndexOptions = {},
): Promise<LexicalIndexResult> {
  const repoPath = path.resolve(inputPath);
  const progress = options.progress ?? silentProgressRunner;
  const startedAt = performance.now();
  const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
  const repoId = store.ensureRepository(getRepositoryIdentity(repoPath)).id;
  const attemptedFiles: Array<{ file: string; fileHash: string }> = [];

  try {
    const storedVersion = store.getVersion(repoId, "lexical");
    const fullRebuild = storedVersion !== LEXICAL_INDEX_VERSION;
    const files = await progress.run("Scanning repository", async (reporter) => {
      const scannedFiles = await scanRepo(repoPath);
      reporter.update(`${scannedFiles.length} found`);
      return scannedFiles;
    });
    const capabilityStates = store.getFileCapabilityStates(repoId, "lexical");
    const currentFiles = new Set(files.map((file) => path.relative(repoPath, file)));
    const filesToIndex: string[] = [];
    let skippedFiles = 0;

    for (const file of files) {
      const relativePath = path.relative(repoPath, file);
      const fileHash = createFileHash(await fs.readFile(file, "utf8"));
      const previous = capabilityStates.get(relativePath);
      if (!fullRebuild && previous?.state === "ready" && previous.fileHash === fileHash) {
        skippedFiles += 1;
      } else {
        if (previous?.state === "ready") {
          store.setFileCapabilityState(repoId, relativePath, "lexical", {
            fileHash,
            version: LEXICAL_INDEX_VERSION,
            state: "stale",
            generation: previous.generation,
            itemCount: previous.itemCount,
          });
        }
        attemptedFiles.push({ file: relativePath, fileHash });
        filesToIndex.push(file);
      }
    }

    const deletedFiles = Array.from(capabilityStates.keys()).filter(
      (file) => !currentFiles.has(file),
    );
    const updates = await progress.run(
      "Parsing source",
      (reporter) => createUpdates(repoPath, repoId, filesToIndex, reporter),
    );

    if (updates.length === 0 && deletedFiles.length === 0 && !fullRebuild) {
      return {
        repoPath, repoId, status: "current", storedVersion,
        version: LEXICAL_INDEX_VERSION, versionChanged: false, fullRebuild: false,
        files: files.length, indexedFiles: 0, skippedFiles, deletedFiles: 0,
        documents: 0, totalMs: performance.now() - startedAt,
      };
    }

    await progress.run("Writing SQLite", () => store.replaceLexicalDocuments(
      repoId, updates, deletedFiles, LEXICAL_INDEX_VERSION,
    ));

    return {
      repoPath, repoId, status: "indexed", storedVersion,
      version: LEXICAL_INDEX_VERSION, versionChanged: fullRebuild, fullRebuild,
      files: files.length, indexedFiles: updates.length, skippedFiles,
      deletedFiles: deletedFiles.length,
      documents: updates.reduce((total, update) => total + update.documents.length, 0),
      totalMs: performance.now() - startedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const states = store.getFileCapabilityStates(repoId, "lexical");

    for (const attempted of attemptedFiles) {
      const previous = states.get(attempted.file);
      store.setFileCapabilityState(repoId, attempted.file, "lexical", {
        fileHash: attempted.fileHash,
        version: LEXICAL_INDEX_VERSION,
        state: "error",
        generation: previous?.generation,
        itemCount: previous?.itemCount ?? 0,
        lastError: message,
      });
    }

    throw error;
  } finally {
    store.close();
  }
}

export const syncLexical = indexLexical;
