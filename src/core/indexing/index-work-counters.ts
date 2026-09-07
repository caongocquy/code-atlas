export type IndexWorkCounters = {
  filesScanned: number;
  filesHashed: number;
  factCacheHits: number;
  factCacheMisses: number;
  filesParsed: number;
  filesResolved: number;
  importersInvalidated: number;
  fullResolutionFallbacks: number;
};

export function createIndexWorkCounters(): IndexWorkCounters {
  return {
    filesScanned: 0,
    filesHashed: 0,
    factCacheHits: 0,
    factCacheMisses: 0,
    filesParsed: 0,
    filesResolved: 0,
    importersInvalidated: 0,
    fullResolutionFallbacks: 0,
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
