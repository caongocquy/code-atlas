import type { IndexedFileState } from "../repository/indexed-file-state.js";

export type VectorPoint = {
  id: string | number;
  vector: number[];
  payload: Record<string, unknown>;
};

export type VectorSearchResult = {
  score: number;
  payload?: Record<string, unknown> | null;
};

export type VectorStore = {
  readonly id: string;

  isAvailable(): Promise<boolean>;

  ensureCollection(dimensions: number): Promise<void>;

  search(
    repositoryId: string | undefined,
    vector: number[],
    limit: number,
  ): Promise<VectorSearchResult[]>;

  count(repositoryId: string): Promise<number>;

  getIndexedFileStates(repositoryId: string): Promise<Map<string, IndexedFileState>>;

  upsert(points: VectorPoint[]): Promise<void>;

  deletePointIds(pointIds: Array<string | number>): Promise<void>;

  deleteFile(repositoryId: string, file: string): Promise<void>;
};
