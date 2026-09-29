export interface CatalogStore {
  load(id: string): string;
}

export class MemoryCatalogStore implements CatalogStore {
  load(id: string): string {
    return `catalog:${id}`;
  }
}

export function getCatalogItem(store: CatalogStore, id: string): string {
  return store.load(id);
}

export function getCatalogItemMetadata(id: string): string {
  return `metadata:${id}`;
}
