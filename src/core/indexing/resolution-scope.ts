import type { CodeGraph } from "../graph/types.js";
import type {
  CandidateResolutionInput,
  IndexedSourceUnit,
  ResolutionScope,
} from "./indexing.types.js";

export function createCandidateResolutionInput(
  units: readonly IndexedSourceUnit[],
  scope: ResolutionScope,
  previousGenerationId: string | undefined,
  previousGraph: CodeGraph | undefined,
): CandidateResolutionInput {
  const allUnits = [...units].sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  const known = new Set(allUnits.map((unit) => unit.relativePath));
  const paths = scope.mode === "repository" ? allUnits.map((unit) => unit.relativePath) : [...scope.paths].sort();
  if (paths.some((path) => !known.has(path))) throw new Error("resolution scope contains an unknown path");
  return { allUnits, scope: { ...scope, paths }, previousGenerationId, previousGraph };
}
