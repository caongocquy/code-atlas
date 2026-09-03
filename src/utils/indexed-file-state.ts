export type IndexedFileState = {
  fileHash: string;
  pointIds: Array<string | number>;
};

export type IndexedFilePoint = {
  id: string | number;
  payload?: Record<string, unknown> | null;
};

export function collectIndexedFileStates(
  points: IndexedFilePoint[],
): Map<string, IndexedFileState> {
  const states = new Map<string, IndexedFileState>();

  for (const point of points) {
    const payload = point.payload ?? {};
    const file = typeof payload.file === "string" ? payload.file : undefined;
    const fileHash = typeof payload.fileHash === "string" ? payload.fileHash : undefined;

    if (!file || !fileHash) {
      continue;
    }

    const existing = states.get(file);

    if (existing) {
      existing.pointIds.push(point.id);
    } else {
      states.set(file, { fileHash, pointIds: [point.id] });
    }
  }

  return states;
}

export function mergeIndexedFileStates(
  states: Map<string, IndexedFileState>,
  page: Map<string, IndexedFileState>,
): void {
  for (const [file, indexed] of page) {
    const existing = states.get(file);

    if (existing) {
      existing.pointIds.push(...indexed.pointIds);
    } else {
      states.set(file, indexed);
    }
  }
}
