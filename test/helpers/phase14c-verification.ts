export function compareFailureNames(actual: readonly string[], baseline: readonly string[]): { newFailures: string[]; resolvedFailures: string[] } {
  return {
    newFailures: actual.filter((name) => !baseline.includes(name)).sort(),
    resolvedFailures: baseline.filter((name) => !actual.includes(name)).sort(),
  };
}
