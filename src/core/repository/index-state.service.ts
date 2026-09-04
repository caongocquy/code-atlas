import type { VectorStore } from "../semantic/vector-store.js";
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
  vectorStore: VectorStore,
): Promise<Map<string, IndexedFileState>> {
  return vectorStore.getIndexedFileStates(repoId);
}

export async function deletePointIds(
  vectorStore: VectorStore,
  pointIds: Array<string | number>,
): Promise<void> {
  await vectorStore.deletePointIds(pointIds);
}

export async function deleteIndexedFile(
  vectorStore: VectorStore,
  repoId: string,
  file: string,
): Promise<void> {
  await vectorStore.deleteFile(repoId, file);
}
