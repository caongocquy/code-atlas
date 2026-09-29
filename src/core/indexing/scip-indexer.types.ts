import type { IndexedSourceUnit } from "./indexing.types.js";
import type { ScipBindingEvidence } from "../graph/resolver/scip-evidence.js";

export type ScipIndexerStatus = "ready" | "unavailable" | "failed";

export type ScipTool = {
  executablePath: string;
  nodeEntryPoint?: string;
  source: "project-local" | "path";
  version: string;
};

export type ScipDiscovery = {
  status: ScipIndexerStatus;
  tool?: ScipTool;
  diagnostic?: string;
};

export type ScipIndexer = {
  discover(projectRoot: string): Promise<ScipDiscovery>;
  index(input: {
    projectRoot: string;
    repositoryId: string;
    tool: ScipTool;
    units: readonly IndexedSourceUnit[];
  }): Promise<readonly ScipBindingEvidence[]>;
};
