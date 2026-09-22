export function searchStore(store, normalizedQuery) {
  return store.search(normalizedQuery);
}

export function buildStore(entries) {
  return { search: (query) => entries.filter((entry) => entry.includes(query)) };
}
