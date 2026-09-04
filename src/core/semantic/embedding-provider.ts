export type EmbeddingProvider = {
  readonly id: string;
  readonly version: string;
  readonly dimensions: number;

  isAvailable(): Promise<boolean>;

  embedBatch(texts: string[]): Promise<number[][]>;
};
