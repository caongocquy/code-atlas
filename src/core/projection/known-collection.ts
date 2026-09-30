export type ProjectionCount = {
  total: number;
  returned: number;
  omitted: number;
  truncated: boolean;
};

export type ProjectionOrdering<T> =
  | { kind: "preserve" }
  | { kind: "canonical-sort"; compare: (left: T, right: T) => number };

export function exactProjectionCount(total: number, returned: number): ProjectionCount {
  if (!Number.isSafeInteger(total) || !Number.isSafeInteger(returned) || total < 0 || returned < 0 || returned > total) {
    throw new RangeError("Projection counts must be non-negative integers with returned <= total.");
  }
  const omitted = total - returned;
  return { total, returned, omitted, truncated: omitted > 0 };
}

export function projectKnownCollection<T>(
  items: readonly T[],
  limit: number,
  ordering: ProjectionOrdering<T>,
): { items: T[]; count: ProjectionCount } {
  if (!Number.isSafeInteger(limit) || limit < 0) throw new RangeError("Projection limit must be a non-negative integer.");
  const ordered = ordering.kind === "preserve" ? items : [...items].sort(ordering.compare);
  const projected = ordered.slice(0, limit);
  return { items: projected, count: exactProjectionCount(items.length, projected.length) };
}
