import { REPO_CODE_COLLECTION } from "../../config/constants.js";
import { qdrant } from "../../infrastructure/vector/qdrant.client.js";
import {
  collectIndexedFileStates,
  mergeIndexedFileStates,
  type IndexedFileState,
} from "./indexed-file-state.js";

export { collectIndexedFileStates } from "./indexed-file-state.js";
export { mergeIndexedFileStates } from "./indexed-file-state.js";
export type { IndexedFilePoint, IndexedFileState } from "./indexed-file-state.js";

export async function getIndexedFileStates(
  repoId: string,
): Promise<Map<string, IndexedFileState>> {
  const states = new Map<string, IndexedFileState>();

  let offset: string | number | Record<string, unknown> | null | undefined;

  do {
    const response = await qdrant.scroll(REPO_CODE_COLLECTION, {
      limit: 256,
      offset,
      with_payload: true,
      with_vector: false,

      filter: {
        must: [
          {
            key: "repoId",
            match: {
              value: repoId,
            },
          },
        ],
      },
    });

    mergeIndexedFileStates(states, collectIndexedFileStates(response.points));

    offset = response.next_page_offset;
  } while (offset);

  return states;
}

export async function deletePointIds(
  pointIds: Array<string | number>,
): Promise<void> {
  if (pointIds.length === 0) {
    return;
  }

  await qdrant.delete(REPO_CODE_COLLECTION, {
    wait: true,
    points: pointIds,
  });
}

export async function deleteIndexedFile(
  repoId: string,
  file: string,
): Promise<void> {
  await qdrant.delete(REPO_CODE_COLLECTION, {
    wait: true,

    filter: {
      must: [
        {
          key: "repoId",
          match: {
            value: repoId,
          },
        },
        {
          key: "file",
          match: {
            value: file,
          },
        },
      ],
    },
  });
}
