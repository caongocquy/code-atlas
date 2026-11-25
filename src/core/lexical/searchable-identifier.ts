/** The first term is the original symbol name; the remaining terms support lexical matching. */
export function searchableIdentifier(value: string): string {
  const parts = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean);

  return [value, ...parts].join(" ");
}
