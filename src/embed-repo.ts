import fs from "node:fs/promises";
import path from "node:path";

import { runProgressTask } from "./cli/progress.js";
import { formatNotice, formatSummary } from "./cli/format.js";
import {
  EMBEDDING_BATCH_SIZE,
  EMBEDDING_DIMENSIONS,
  REPO_CODE_COLLECTION,
  UPSERT_BATCH_SIZE,
  VECTOR_INDEX_VERSION,
} from "./config/constants.js";
import type { ProgressReporter } from "./cli/types.js";
import { embedBatch } from "./lib/embedding.js";
import { qdrant } from "./lib/qdrant.js";
import { parseCodeSymbols } from "./parsers/code-parser.js";
import type { CodeChunk } from "./parsers/types.js";
import {
  deleteIndexedFile,
  deletePointIds,
  getIndexedFileStates,
  type IndexedFileState,
} from "./services/index-state.js";
import { IndexMetadataStore } from "./services/index-metadata.js";
import { buildEmbeddingText } from "./utils/embedding-text.js";
import { createFileHash } from "./utils/file-hash.js";
import { createPointId } from "./utils/point-id.js";
import { getRepoId, scanRepo } from "./utils/repo.js";
import { splitLargeSymbol } from "./utils/split-symbol.js";
import { runCopyOnWriteGeneration } from "./utils/copy-on-write.js";
import { vectorRefreshMode } from "./utils/index-version.js";

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

async function ensureCollection(): Promise<void> {
  const collections = await qdrant.getCollections();

  const exists = collections.collections.some(
    (collection) => collection.name === REPO_CODE_COLLECTION,
  );

  if (exists) {
    return;
  }

  await qdrant.createCollection(REPO_CODE_COLLECTION, {
    vectors: {
      size: EMBEDDING_DIMENSIONS,
      distance: "Cosine",
    },
  });
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

async function main(): Promise<void> {
  const repoPath = process.argv[2] ?? ".";

  const absoluteRepoPath = path.resolve(repoPath);
  const startedAt = performance.now();

  await ensureCollection();

  const repoId = getRepoId(absoluteRepoPath);

  const metadataStore = new IndexMetadataStore();

  try {
    const storedIndexVersion = metadataStore.getVersion(repoId, "vector");

    const forceFullReindex =
      vectorRefreshMode(storedIndexVersion, VECTOR_INDEX_VERSION) === "semantic-reindex";

    if (forceFullReindex) {
      console.log(
        formatNotice(
          "Vector index version changed",
          `${storedIndexVersion ?? "none"} → ${VECTOR_INDEX_VERSION}`,
          "warning",
        ),
      );
      console.log(formatNotice("Full reindex required", undefined, "warning"));
    }

    const files = await runProgressTask(
      "Scanning repository",
      async (reporter) => {
        const scannedFiles = await scanRepo(absoluteRepoPath);
        reporter.update(`${scannedFiles.length} found`);
        return scannedFiles;
      },
      "vector",
    );

    let indexedStates = new Map<string, IndexedFileState>();

    const currentFiles = new Set<string>();

    const preparedFiles: PreparedFile[] = [];

    let addedFiles = 0;
    let updatedFiles = 0;
    let skippedFiles = 0;
    let deletedFiles = 0;

    let embeddedSymbols = 0;
    let writtenPoints = 0;
    let cleanedOldPoints = 0;

    await runProgressTask("Parsing source", async (reporter) => {
      indexedStates = await getIndexedFileStates(repoId);

      for (let index = 0; index < files.length; index += 1) {
        const filePath = files[index];

        if (!filePath) {
          continue;
        }

        const relativePath = path.relative(absoluteRepoPath, filePath);

        currentFiles.add(relativePath);

        const content = await fs.readFile(filePath, "utf8");
        const fileHash = createFileHash(content);
        const previousState = indexedStates.get(relativePath);

        if (!forceFullReindex && previousState?.fileHash === fileHash) {
          skippedFiles += 1;
          reporter.setProgress(index + 1, files.length);
          continue;
        }

        const parsedChunks = parseCodeSymbols(content, relativePath);
        const chunks = parsedChunks.flatMap(splitLargeSymbol);
        const generationId = [`v${VECTOR_INDEX_VERSION}`, fileHash].join(":");

        preparedFiles.push({
          relativePath,
          fileHash,
          generationId,
          chunks,
          previousPointIds: previousState?.pointIds ?? [],
        });

        if (previousState) {
          updatedFiles += 1;
        } else {
          addedFiles += 1;
        }

        reporter.setProgress(index + 1, files.length);
      }
    }, "vector");

    //
    // Deleted files
    //

    const deletedFileNames = Array.from(indexedStates.keys()).filter(
      (indexedFile) => !currentFiles.has(indexedFile),
    );

    if (deletedFileNames.length > 0) {
      await runProgressTask("Cleaning deleted files", async (reporter) => {
        for (let index = 0; index < deletedFileNames.length; index += 1) {
          const indexedFile = deletedFileNames[index];

          if (!indexedFile) {
            continue;
          }

          await deleteIndexedFile(repoId, indexedFile);
          deletedFiles += 1;
          reporter.setProgress(index + 1, deletedFileNames.length);
        }
      }, "vector");
    }

    //
    // Flatten changed/new chunks
    //

    let preparedChunks: PreparedChunk[] = [];

    await runProgressTask("Preparing chunks", async (reporter) => {
      preparedChunks = preparedFiles.flatMap((preparedFile) =>
        preparedFile.chunks.map((chunk) => ({
          relativePath: preparedFile.relativePath,
          fileHash: preparedFile.fileHash,
          generationId: preparedFile.generationId,
          chunk,
        })),
      );
      reporter.update(`${preparedChunks.length} chunks`);
    }, "vector");

    if (preparedChunks.length === 0) {
      //
      // Even if there were only deleted files, the index
      // operation completed successfully, so it is safe
      // to persist the current vector index version.
      //

      await runProgressTask("Nothing to index", () => {
        metadataStore.setVersion(repoId, "vector", VECTOR_INDEX_VERSION);
      }, "vector");

      console.log(
        formatSummary("Nothing to index", [
          { label: "Files", value: files.length },
          { label: "Added", value: addedFiles, tone: "warning" },
          { label: "Updated", value: updatedFiles, tone: "warning" },
          { label: "Skipped", value: skippedFiles },
          { label: "Deleted", value: deletedFiles, tone: "warning" },
          { label: "Version", value: VECTOR_INDEX_VERSION },
          { label: "Time", value: `${(performance.now() - startedAt).toFixed(1)} ms` },
        ], "vector"),
      );

      return;
    }

    //
    // Phase 2: Batch embedding
    //

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
        const vectors = await embedBatch(embeddingTexts);

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

    const writePoints = async (reporter: ProgressReporter): Promise<void> => {
      for (const batch of upsertBatches) {
        await qdrant.upsert(REPO_CODE_COLLECTION, {
          wait: true,
          points: batch,
        });

        writtenPoints += batch.length;

        reporter.setProgress(writtenPoints, allPoints.length);
      }
    };

    await runProgressTask("Embedding chunks", embedChunks, "vector");

    // Phase 3: Cross-file batch upsert. All new generations are written first.
    const fileEntries = Array.from(pointsByFile.values());
    const allPoints = fileEntries.flatMap((fileEntry) => fileEntry.points);
    const upsertBatches = chunkArray(allPoints, UPSERT_BATCH_SIZE);

    const cleanupTargets = fileEntries.filter(
      (fileEntry) => fileEntry.previousPointIds.length > 0,
    );

    await runCopyOnWriteGeneration({
      stage: async () => {
        await runProgressTask("Writing Qdrant", writePoints, "vector");
        return fileEntries;
      },
      cleanup: async () => {
        if (cleanupTargets.length === 0) {
          return;
        }

        await runProgressTask("Cleaning old generation", async (reporter) => {
          for (let index = 0; index < cleanupTargets.length; index += 1) {
            const fileEntry = cleanupTargets[index];

            if (!fileEntry) {
              continue;
            }

            await deletePointIds(fileEntry.previousPointIds);
            cleanedOldPoints += fileEntry.previousPointIds.length;
            reporter.setProgress(index + 1, cleanupTargets.length);
          }
        }, "vector");
      },
      activate: async () => {
        metadataStore.setVersion(repoId, "vector", VECTOR_INDEX_VERSION);
      },
    });

    console.log(
      formatSummary("Vector indexed", [
        { label: "Files", value: files.length },
        { label: "Chunks", value: preparedChunks.length },
        { label: "Points", value: writtenPoints },
        { label: "Embedded", value: embeddedSymbols },
        { label: "Cleaned points", value: cleanedOldPoints },
        { label: "Version", value: VECTOR_INDEX_VERSION },
        { label: "Full reindex", value: forceFullReindex ? "yes" : "no", tone: forceFullReindex ? "warning" : "muted" },
        { label: "Embedding batches", value: embeddingBatches.length },
        { label: "Embedding batch size", value: EMBEDDING_BATCH_SIZE },
        { label: "Qdrant batches", value: upsertBatches.length },
        { label: "Qdrant batch size", value: UPSERT_BATCH_SIZE },
        { label: "Added", value: addedFiles, tone: "warning" },
        { label: "Updated", value: updatedFiles, tone: "warning" },
        { label: "Skipped", value: skippedFiles },
        { label: "Deleted", value: deletedFiles, tone: "warning" },
        { label: "Time", value: `${(performance.now() - startedAt).toFixed(1)} ms` },
      ], "vector"),
    );
  } finally {
    metadataStore.close();
  }
}

main().catch((error) => {
  console.error(error);

  process.exit(1);
});
