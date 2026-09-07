import fs from "node:fs/promises";
import path from "node:path";

import type {
  ProgressReporter,
  ProgressRunner,
} from "../progress/progress.types.js";
import {
  EMBEDDING_BATCH_SIZE,
  UPSERT_BATCH_SIZE,
  VECTOR_INDEX_VERSION,
} from "../../config/constants.js";
import { parseCodeSymbols } from "../graph/parsers/code-parser.js";
import type { CodeChunk } from "../graph/parsers/types.js";
import {
  deleteIndexedFile,
  deletePointIds,
  getIndexedFileStates,
} from "../repository/index-state.service.js";
import { AtlasStore } from "../../storage/atlas/atlas.store.js";
import { silentProgressRunner } from "../progress/silent-progress-runner.js";
import { buildEmbeddingText } from "./embedding-text.js";
import { createFileHash } from "../repository/file-hash.js";
import { createPointId } from "./point-id.js";
import {
  canonicalRepositoryPath,
  getRepositoryIdentity,
} from "../repository/repository-identity.js";
import {
  repositoryRelativePath,
  scanRepo,
} from "../repository/repository-files.js";
import { splitLargeSymbol } from "./split-symbol.js";
import { runCopyOnWriteGeneration } from "./copy-on-write.js";
import { vectorRefreshMode } from "../repository/index-version.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import type { VectorStore } from "./vector-store.js";
import type { IndexedFileState } from "../repository/indexed-file-state.js";
import {
  embeddingProviderIdentity,
  semanticGenerationIdentity,
} from "./provider-identity.js";
import { codeChunksFromFacts, type IndexedSourceUnit } from "../indexing/indexing.types.js";

type PreparedFile = {
  relativePath: string;
  fileHash: string;
  generationId: string;
  chunks: CodeChunk[];
  previousPointIds: Array<string | number>;
};

type PreparedChunk = {
  relativePath: string;
  fileHash: string;
  generationId: string;
  chunk: CodeChunk;
};

type PreparedFilePoints = {
  relativePath: string;
  generationId: string;
  previousPointIds: Array<string | number>;
  points: Array<{
    id: string;
    vector: number[];
    payload: Record<string, unknown>;
  }>;
};

export type SemanticIndexOptions = {
  progress?: ProgressRunner;
  files?: string[];
  candidateFiles?: string[];
  deletedFiles?: string[];
  fileHashes?: Map<string, string>;
  forceFullReindex?: boolean;
  embeddingProvider?: EmbeddingProvider;
  vectorStore?: VectorStore;
  units?: IndexedSourceUnit[];
};

export type SemanticIndexResult = {
  repoPath: string;
  repoId: string;
  status: "indexed" | "nothing-to-index" | "not-configured" | "unavailable";
  storedVersion?: string;
  version: string;
  fullReindex: boolean;
  files: number;
  chunks: number;
  points: number;
  embeddedSymbols: number;
  cleanedOldPoints: number;
  embeddingBatches: number;
  vectorBatches: number;
  addedFiles: number;
  updatedFiles: number;
  skippedFiles: number;
  deletedFiles: number;
  totalMs: number;
  error?: string;
};

function unavailableResult(
  repoPath: string,
  repoId: string,
  startedAt: number,
  error?: unknown,
): SemanticIndexResult {
  return {
    repoPath,
    repoId,
    status: "unavailable",
    version: VECTOR_INDEX_VERSION,
    fullReindex: false,
    files: 0,
    chunks: 0,
    points: 0,
    embeddedSymbols: 0,
    cleanedOldPoints: 0,
    embeddingBatches: 0,
    vectorBatches: 0,
    addedFiles: 0,
    updatedFiles: 0,
    skippedFiles: 0,
    deletedFiles: 0,
    totalMs: performance.now() - startedAt,
    error: error instanceof Error ? error.message : error ? String(error) : undefined,
  };
}

function generationIdFor(
  fileHash: string,
  providerIdentity: string,
  vectorStoreId: string,
  previousProviderIdentity?: string,
  hasPreviousIndex = false,
): string {
  return semanticGenerationIdentity(
    fileHash,
    providerIdentity,
    vectorStoreId,
    previousProviderIdentity,
    hasPreviousIndex,
  );
}

function chunkArray<T>(items: T[], size: number): T[][] {
  if (size <= 0) {
    throw new Error("Batch size must be greater than 0");
  }

  const batches: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    batches.push(items.slice(index, index + size));
  }

  return batches;
}

export async function syncSemantic(
  inputPath: string,
  options: SemanticIndexOptions = {},
): Promise<SemanticIndexResult> {
  const repoPath = canonicalRepositoryPath(path.resolve(inputPath));
  const progress = options.progress ?? silentProgressRunner;
  const startedAt = performance.now();
  const embeddingProvider = options.embeddingProvider;
  const vectorStore = options.vectorStore;
  const repositoryId = getRepositoryIdentity(repoPath).id;

  if (!embeddingProvider || !vectorStore) {
    return {
      repoPath,
      repoId: repositoryId,
      status: "not-configured",
      version: VECTOR_INDEX_VERSION,
      fullReindex: false,
      files: 0,
      chunks: 0,
      points: 0,
      embeddedSymbols: 0,
      cleanedOldPoints: 0,
      embeddingBatches: 0,
      vectorBatches: 0,
      addedFiles: 0,
      updatedFiles: 0,
      skippedFiles: 0,
      deletedFiles: 0,
      totalMs: performance.now() - startedAt,
    };
  }

  let providerAvailable: boolean;

  try {
    providerAvailable = await embeddingProvider.isAvailable() && await vectorStore.isAvailable();
  } catch (error) {
    return unavailableResult(repoPath, repositoryId, startedAt, error);
  }

  if (!providerAvailable) {
    return unavailableResult(repoPath, repositoryId, startedAt);
  }

  const providerIdentity = embeddingProviderIdentity(embeddingProvider);
  await vectorStore.ensureCollection(embeddingProvider.dimensions);

  const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
  const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
  const repoId = repository.id;
  let preparedFiles: PreparedFile[] = [];

  try {
    const storedIndexVersion = store.getVersion(repoId, "semantic");
    const forceFullReindex = options.forceFullReindex === true ||
      vectorRefreshMode(storedIndexVersion, VECTOR_INDEX_VERSION) === "semantic-reindex";

    const files = options.files ?? await progress.run(
      "Scanning repository",
      async (reporter) => {
        const scannedFiles = await scanRepo(repoPath);
        reporter.update(`${scannedFiles.length} found`);
        return scannedFiles;
      },
      "vector",
    );
    const candidateFiles = options.candidateFiles
      ? new Set(options.candidateFiles)
      : undefined;

    let indexedStates = new Map<string, IndexedFileState>();
    const currentFiles = new Set<string>();
    let addedFiles = 0;
    let updatedFiles = 0;
    let skippedFiles = 0;
    let deletedFiles = 0;
    let embeddedSymbols = 0;
    let writtenPoints = 0;
    let cleanedOldPoints = 0;

    await progress.run(
      "Parsing source",
      async (reporter) => {
        indexedStates = await getIndexedFileStates(repoId, vectorStore);
        const capabilityStates = store.getFileCapabilityStates(repoId, "semantic");

        for (let index = 0; index < files.length; index += 1) {
          const filePath = files[index];

          if (!filePath) {
            continue;
          }

          const relativePath = repositoryRelativePath(repoPath, filePath);
          currentFiles.add(relativePath);

          const shouldConsider = forceFullReindex || !candidateFiles || candidateFiles.has(relativePath);

          if (!shouldConsider) {
            skippedFiles += 1;
            reporter.setProgress(index + 1, files.length);
            continue;
          }

          const indexedUnit = options.units?.find((unit) => unit.relativePath === relativePath);
          const content = indexedUnit?.source ?? await fs.readFile(filePath, "utf8");
          const fileHash = options.fileHashes?.get(relativePath) ?? createFileHash(content);
          const previousState = capabilityStates.get(relativePath);
          const previousPointState = indexedStates.get(relativePath);
          const generationId = generationIdFor(
            fileHash,
            providerIdentity,
            vectorStore.id,
            previousState?.providerIdentity,
            previousState !== undefined || previousPointState !== undefined,
          );

          if (
            !forceFullReindex &&
            previousState?.state === "ready" &&
            previousState.fileHash === fileHash &&
            previousState.providerIdentity === providerIdentity &&
            previousState.generation === generationId
          ) {
            skippedFiles += 1;
            reporter.setProgress(index + 1, files.length);
            continue;
          }

          const chunks = indexedUnit
            ? codeChunksFromFacts(indexedUnit).flatMap(splitLargeSymbol)
            : parseCodeSymbols(content, relativePath).flatMap(splitLargeSymbol);
          preparedFiles.push({
            relativePath,
            fileHash,
            generationId,
            chunks,
            previousPointIds: previousPointState?.pointIds ?? [],
          });

          if (previousState) {
            updatedFiles += 1;
          } else {
            addedFiles += 1;
          }

          reporter.setProgress(index + 1, files.length);
        }
      },
      "vector",
    );

    const capabilityStates = store.getFileCapabilityStates(repoId, "semantic");
    const deletedFileNames = Array.from(capabilityStates.keys()).filter(
      (indexedFile) => !currentFiles.has(indexedFile),
    );

    if (deletedFileNames.length > 0) {
      await progress.run(
        "Cleaning deleted files",
        async (reporter) => {
          for (let index = 0; index < deletedFileNames.length; index += 1) {
            const indexedFile = deletedFileNames[index];

            if (!indexedFile) {
              continue;
            }

            await deleteIndexedFile(vectorStore, repoId, indexedFile);
            store.deleteFileCapabilityState(repoId, indexedFile, "semantic");
            deletedFiles += 1;
            reporter.setProgress(index + 1, deletedFileNames.length);
          }
        },
        "vector",
      );
    }

    let preparedChunks: PreparedChunk[] = [];

    await progress.run(
      "Preparing chunks",
      async (reporter) => {
        preparedChunks = preparedFiles.flatMap((preparedFile) =>
          preparedFile.chunks.map((chunk) => ({
            relativePath: preparedFile.relativePath,
            fileHash: preparedFile.fileHash,
            generationId: preparedFile.generationId,
            chunk,
          })),
        );
        reporter.update(`${preparedChunks.length} chunks`);
      },
      "vector",
    );

    if (preparedChunks.length === 0) {
      for (const preparedFile of preparedFiles) {
        if (preparedFile.previousPointIds.length === 0) {
          continue;
        }

        await deletePointIds(vectorStore, preparedFile.previousPointIds);
        cleanedOldPoints += preparedFile.previousPointIds.length;
      }

      await progress.run(
        "Nothing to index",
        () => {
          for (const preparedFile of preparedFiles) {
            store.setFileCapabilityState(repoId, preparedFile.relativePath, "semantic", {
              fileHash: preparedFile.fileHash,
              version: VECTOR_INDEX_VERSION,
              state: "ready",
              providerIdentity,
              generation: preparedFile.generationId,
              itemCount: 0,
            });
          }
          store.setVersion(repoId, "semantic", VECTOR_INDEX_VERSION);
        },
        "vector",
      );

      return {
        repoPath,
        repoId,
        status: "nothing-to-index",
        storedVersion: storedIndexVersion,
        version: VECTOR_INDEX_VERSION,
        fullReindex: forceFullReindex,
        files: files.length,
        chunks: 0,
        points: 0,
        embeddedSymbols: 0,
        cleanedOldPoints: 0,
        embeddingBatches: 0,
        vectorBatches: 0,
        addedFiles,
        updatedFiles,
        skippedFiles,
        deletedFiles,
        totalMs: performance.now() - startedAt,
      };
    }

    const embeddingBatches = chunkArray(preparedChunks, EMBEDDING_BATCH_SIZE);
    const pointsByFile = new Map<string, PreparedFilePoints>();
    const preparedFileMap = new Map(
      preparedFiles.map((file) => [file.relativePath, file]),
    );

    const embedChunks = async (reporter: ProgressReporter): Promise<void> => {
      for (const batch of embeddingBatches) {
        const embeddingTexts = batch.map(({ chunk, relativePath }) =>
          buildEmbeddingText(relativePath, chunk),
        );
        const vectors = await embeddingProvider.embedBatch(embeddingTexts);

        if (vectors.length !== batch.length) {
          throw new Error(
            `Embedding batch mismatch: expected ${batch.length}, received ${vectors.length}`,
          );
        }

        for (let index = 0; index < batch.length; index += 1) {
          const item = batch[index];
          const vector = vectors[index];

          if (!item || !vector) {
            throw new Error(`Missing embedding result at batch index ${index}`);
          }

          const { relativePath, fileHash, generationId, chunk } = item;
          const pointId = createPointId(
            repoId,
            relativePath,
            chunk.symbolType,
            chunk.symbolName,
            chunk.part ?? 1,
            generationId,
          );
          const point = {
            id: pointId,
            vector,
            payload: {
              repoId,
              file: relativePath,
              fileHash,
              generationId,
              indexVersion: VECTOR_INDEX_VERSION,
              language: chunk.language,
              symbolName: chunk.symbolName,
              symbolType: chunk.symbolType,
              startLine: chunk.startLine,
              endLine: chunk.endLine,
              content: chunk.content,
              part: chunk.part,
              totalParts: chunk.totalParts,
            },
          };
          const existing = pointsByFile.get(relativePath);

          if (existing) {
            existing.points.push(point);
          } else {
            const preparedFile = preparedFileMap.get(relativePath);

            pointsByFile.set(relativePath, {
              relativePath,
              generationId,
              previousPointIds: preparedFile?.previousPointIds ?? [],
              points: [point],
            });
          }
        }

        embeddedSymbols += batch.length;
        reporter.setProgress(embeddedSymbols, preparedChunks.length);
      }
    };

    await progress.run("Embedding chunks", embedChunks, "vector");

    const fileEntries = Array.from(pointsByFile.values());
    const allPoints = fileEntries.flatMap((fileEntry) => fileEntry.points);
    const upsertBatches = chunkArray(allPoints, UPSERT_BATCH_SIZE);

    const writePoints = async (reporter: ProgressReporter): Promise<void> => {
      for (const batch of upsertBatches) {
        await vectorStore.upsert(batch);

        writtenPoints += batch.length;
        reporter.setProgress(writtenPoints, allPoints.length);
      }
    };

    const cleanupTargets = fileEntries.filter(
      (fileEntry) => fileEntry.previousPointIds.length > 0,
    );

    await runCopyOnWriteGeneration({
      stage: async () => {
        await progress.run("Writing vector index", writePoints, "vector");
        return fileEntries;
      },
      cleanup: async () => {
        if (cleanupTargets.length === 0) {
          return;
        }

        await progress.run(
          "Cleaning old generation",
          async (reporter) => {
            for (let index = 0; index < cleanupTargets.length; index += 1) {
              const fileEntry = cleanupTargets[index];

              if (!fileEntry) {
                continue;
              }

              const currentPointIds = new Set<string | number>(
                fileEntry.points.map((point) => point.id),
              );
              const stalePointIds = fileEntry.previousPointIds.filter(
                (pointId) => !currentPointIds.has(pointId),
              );

              await deletePointIds(vectorStore, stalePointIds);
              cleanedOldPoints += stalePointIds.length;
              reporter.setProgress(index + 1, cleanupTargets.length);
            }
          },
          "vector",
        );
      },
      activate: async () => {
        for (const fileEntry of fileEntries) {
          const preparedFile = preparedFileMap.get(fileEntry.relativePath);
          if (!preparedFile) {
            continue;
          }
          store.setFileCapabilityState(repoId, fileEntry.relativePath, "semantic", {
            fileHash: preparedFile.fileHash,
            version: VECTOR_INDEX_VERSION,
            state: "ready",
            providerIdentity,
            generation: fileEntry.generationId,
            itemCount: fileEntry.points.length,
          });
        }
        store.setVersion(repoId, "semantic", VECTOR_INDEX_VERSION);
      },
    });

    return {
      repoPath,
      repoId,
      status: "indexed",
      storedVersion: storedIndexVersion,
      version: VECTOR_INDEX_VERSION,
      fullReindex: forceFullReindex,
      files: files.length,
      chunks: preparedChunks.length,
      points: writtenPoints,
      embeddedSymbols,
      cleanedOldPoints,
      embeddingBatches: embeddingBatches.length,
      vectorBatches: upsertBatches.length,
      addedFiles,
      updatedFiles,
      skippedFiles,
      deletedFiles,
      totalMs: performance.now() - startedAt,
    };
  } catch (error) {
    for (const preparedFile of preparedFiles) {
      store.setFileCapabilityState(repoId, preparedFile.relativePath, "semantic", {
        fileHash: preparedFile.fileHash,
        version: VECTOR_INDEX_VERSION,
        state: "error",
        providerIdentity,
        generation: preparedFile.generationId,
        itemCount: 0,
        lastError: error instanceof Error ? error.message : String(error),
      });
    }
    throw error;
  } finally {
    store.close();
  }
}

export const indexSemantic = syncSemantic;
