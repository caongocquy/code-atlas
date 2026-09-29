import { normalizeTerm } from "./text-utils.js";
import { searchStore } from "./search-store.js";

export function routeSearch(rawQuery, store) {
  return searchStore(store, normalizeTerm(rawQuery));
}

export function createSearchHandler(store) {
  return function handle(request) {
    return routeSearch(request.query, store);
  };
}
