export class CatalogCache {
  load(key: string): string {
    return `cache:${key}`;
  }

  clear(): void {
    // The fixture only needs a distinct method target.
  }
}
