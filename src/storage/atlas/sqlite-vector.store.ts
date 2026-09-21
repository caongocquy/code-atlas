import type { IndexedFileState } from "../../core/repository/indexed-file-state.js";
import type {
  VectorPoint,
  VectorSearchResult,
  VectorStore,
} from "../../core/semantic/vector-store.js";
import { AtlasStore } from "./atlas.store.js";

export class SqliteVectorStore implements VectorStore {
  readonly id = "sqlite";

  private readonly store: AtlasStore;
  private readonly defaultRepositoryId?: string;

  constructor(databasePath: string, defaultRepositoryId?: string, options: { readOnly?: boolean } = {}) {
    this.store = new AtlasStore(databasePath, options);
    this.defaultRepositoryId = defaultRepositoryId;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }

  async ensureCollection(dimensions: number): Promise<void> {
    this.store.ensureSemanticVectorDimensions(dimensions);
  }

  async search(
    repositoryId: string | undefined,
    vector: number[],
    limit: number,
  ): Promise<VectorSearchResult[]> {
    const targetRepositoryId = repositoryId ?? this.defaultRepositoryId;

    return targetRepositoryId
      ? this.store.searchSemanticVectors(targetRepositoryId, vector, limit)
      : [];
  }

  async count(repositoryId: string): Promise<number> {
    return this.store.countSemanticVectors(repositoryId);
  }

  async getIndexedFileStates(repositoryId: string): Promise<Map<string, IndexedFileState>> {
    return this.store.getSemanticIndexedFileStates(repositoryId);
  }

  async upsert(points: VectorPoint[]): Promise<void> {
    this.store.upsertSemanticVectors(points);
  }

  async deletePointIds(pointIds: Array<string | number>): Promise<void> {
    this.store.deleteSemanticVectorIds(pointIds);
  }

  async deleteFile(repositoryId: string, file: string): Promise<void> {
    this.store.deleteSemanticFile(repositoryId, file);
  }

  close(): void {
    this.store.close();
  }
}
