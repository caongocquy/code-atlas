import {
  EMBEDDING_DIMENSIONS,
  REPO_CODE_COLLECTION,
  UPSERT_BATCH_SIZE,
} from "../../config/constants.js";
import type {
  VectorPoint,
  VectorSearchResult,
  VectorStore,
} from "../../core/semantic/vector-store.js";
import {
  collectIndexedFileStates,
  mergeIndexedFileStates,
  type IndexedFileState,
} from "../../core/repository/indexed-file-state.js";
import { qdrant } from "./qdrant.client.js";

async function getCollections() {
  return qdrant.getCollections();
}

async function hasCollection(): Promise<boolean> {
  const collections = await getCollections();
  return collections.collections.some(
    (collection) => collection.name === REPO_CODE_COLLECTION,
  );
}

export const qdrantVectorStore: VectorStore = {
  id: "qdrant",

  async isAvailable(): Promise<boolean> {
    try {
      await getCollections();
      return true;
    } catch {
      return false;
    }
  },

  async ensureCollection(dimensions: number): Promise<void> {
    const collections = await getCollections();
    const exists = collections.collections.some(
      (collection) => collection.name === REPO_CODE_COLLECTION,
    );

    if (exists) {
      return;
    }

    await qdrant.createCollection(REPO_CODE_COLLECTION, {
      vectors: {
        size: dimensions || EMBEDDING_DIMENSIONS,
        distance: "Cosine",
      },
    });
  },

  async search(
    repositoryId: string | undefined,
    vector: number[],
    limit: number,
  ): Promise<VectorSearchResult[]> {
    if (!(await hasCollection())) {
      return [];
    }

    const result = await qdrant.query(REPO_CODE_COLLECTION, {
      query: vector,
      limit,
      with_payload: true,
      ...(repositoryId
        ? {
            filter: {
              must: [{ key: "repoId", match: { value: repositoryId } }],
            },
          }
        : {}),
    });

    return result.points.map((point) => ({
      score: point.score,
      payload: point.payload,
    }));
  },

  async count(repositoryId: string): Promise<number> {
    if (!(await hasCollection())) {
      return 0;
    }

    const result = await qdrant.count(REPO_CODE_COLLECTION, {
      exact: true,
      filter: {
        must: [{ key: "repoId", match: { value: repositoryId } }],
      },
    });

    return result.count;
  },

  async getIndexedFileStates(repositoryId: string): Promise<Map<string, IndexedFileState>> {
    const states = new Map<string, IndexedFileState>();

    if (!(await hasCollection())) {
      return states;
    }

    let offset: string | number | Record<string, unknown> | null | undefined;

    do {
      const response = await qdrant.scroll(REPO_CODE_COLLECTION, {
        limit: 256,
        offset,
        with_payload: true,
        with_vector: false,
        filter: {
          must: [{ key: "repoId", match: { value: repositoryId } }],
        },
      });

      mergeIndexedFileStates(states, collectIndexedFileStates(response.points));
      offset = response.next_page_offset;
    } while (offset);

    return states;
  },

  async upsert(points: VectorPoint[]): Promise<void> {
    for (let index = 0; index < points.length; index += UPSERT_BATCH_SIZE) {
      await qdrant.upsert(REPO_CODE_COLLECTION, {
        wait: true,
        points: points.slice(index, index + UPSERT_BATCH_SIZE),
      });
    }
  },

  async deletePointIds(pointIds: Array<string | number>): Promise<void> {
    if (pointIds.length === 0) {
      return;
    }

    await qdrant.delete(REPO_CODE_COLLECTION, {
      wait: true,
      points: pointIds,
    });
  },

  async deleteFile(repositoryId: string, file: string): Promise<void> {
    await qdrant.delete(REPO_CODE_COLLECTION, {
      wait: true,
      filter: {
        must: [
          { key: "repoId", match: { value: repositoryId } },
          { key: "file", match: { value: file } },
        ],
      },
    });
  },
};
