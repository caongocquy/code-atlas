import type { SearchResult } from "./code-search.service.js";

export type RerankerProvider = {
  readonly id: string;
  readonly version: string;

  isAvailable(): Promise<boolean>;

  rerank<T extends SearchResult>(
    query: string,
    candidates: T[],
    limit: number,
  ): Promise<Array<T & { rerankScore: number }>>;
};
