export type GraphRefreshMode = "full-rebuild" | "incremental";
export type VectorRefreshMode = "semantic-reindex" | "incremental";

export function graphRefreshMode(
  storedVersion: string | undefined,
  currentVersion: string,
): GraphRefreshMode {
  return storedVersion === currentVersion ? "incremental" : "full-rebuild";
}

export function vectorRefreshMode(
  storedVersion: string | undefined,
  currentVersion: string,
): VectorRefreshMode {
  return storedVersion === currentVersion ? "incremental" : "semantic-reindex";
}
