export type IndexWorkCounters = {
  lexicalFilesUpdated: number;
  lexicalFilesReused: number;
  semanticFilesEmbedded: number;
  semanticFilesReused: number;
  semanticUnitsEmbedded: number;
  semanticUnitsReused: number;
  scipRuns: number;
  scipReused: number;
  graphRowsInserted: number;
  graphRowsCopied: number;
  frameworkRowsCopied: number;
  frameworkRowsInserted: number;
  metadataRowsUpdated: number;
  metadataRowsDeleted: number;
  lexicalDocumentsInserted: number;
  lexicalDocumentsDeleted: number;
  lexicalDocumentsReused: number;
  semanticVectorsWritten: number;
  semanticVectorsCopied: number;
  storageTransactions: number;
  filesScanned: number;
  filesHashed: number;
  factCacheHits: number;
  factCacheMisses: number;
  filesParsed: number;
  filesResolved: number;
  importersInvalidated: number;
  fullResolutionFallbacks: number;
  frameworkFilesResolved: number;
  frameworkFilesReused: number;
};

export function createIndexWorkCounters(): IndexWorkCounters {
  return {
    lexicalFilesUpdated: 0,
    lexicalFilesReused: 0,
    semanticFilesEmbedded: 0,
    semanticFilesReused: 0,
    semanticUnitsEmbedded: 0,
    semanticUnitsReused: 0,
    scipRuns: 0,
    scipReused: 0,
    graphRowsInserted: 0,
    graphRowsCopied: 0,
    frameworkRowsCopied: 0,
    frameworkRowsInserted: 0,
    metadataRowsUpdated: 0,
    metadataRowsDeleted: 0,
    lexicalDocumentsInserted: 0,
    lexicalDocumentsDeleted: 0,
    lexicalDocumentsReused: 0,
    semanticVectorsWritten: 0,
    semanticVectorsCopied: 0,
    storageTransactions: 0,
    filesScanned: 0,
    filesHashed: 0,
    factCacheHits: 0,
    factCacheMisses: 0,
    filesParsed: 0,
    filesResolved: 0,
    importersInvalidated: 0,
    fullResolutionFallbacks: 0,
    frameworkFilesResolved: 0,
    frameworkFilesReused: 0,
  };
}

export function recordIndexWork(
  counters: IndexWorkCounters,
  event: keyof IndexWorkCounters,
  count = 1,
): void {
  counters[event] += count;
}

export function freezeIndexWorkCounters(
  counters: IndexWorkCounters,
): Readonly<IndexWorkCounters> {
  return Object.freeze({ ...counters });
}
