import { getCatalogItem as loadEntry } from "./repository.js";
import { CatalogStore } from "./repository.js";

export function browseCatalog(store: CatalogStore, id: string): string {
  return loadEntry(store, id);
}

export function searchCatalogTitles(titles: string[], term: string): string[] {
  return titles.filter((title) => title.toLowerCase().includes(term.toLowerCase()));
}
