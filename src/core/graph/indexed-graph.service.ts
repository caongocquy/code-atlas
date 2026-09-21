import path from "node:path";

import { AtlasStore } from "../../storage/atlas/atlas.store.js";
import { getRepositoryStatus, getRepositoryStatusReadOnly } from "../repository/repository-status.service.js";
import {
  canonicalRepositoryPath,
  getRepositoryIdentity,
} from "../repository/repository-identity.js";
import type { CodeGraph } from "./types.js";
import { projectFrameworkGraphWithReliability } from "./query/framework-query.service.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../repository/index-version.js";
import type { FrameworkQueryProjection } from "./query/framework-query.types.js";

export type IndexedGraph = {
  repoPath: string;
  repoId: string;
  graph: CodeGraph;
  capabilityState: "ready" | "stale";
  mayBeIncomplete: boolean;
  framework?: FrameworkQueryProjection;
};

export async function loadIndexedGraph(inputPath: string): Promise<IndexedGraph> {
  return loadIndexedGraphInternal(inputPath, false);
}

export async function loadIndexedGraphReadOnly(inputPath: string): Promise<IndexedGraph> {
  return loadIndexedGraphInternal(inputPath, true);
}

async function loadIndexedGraphInternal(inputPath: string, readOnly: boolean): Promise<IndexedGraph> {
  const repoPath = canonicalRepositoryPath(path.resolve(inputPath));
  const status = await (readOnly ? getRepositoryStatusReadOnly(repoPath) : getRepositoryStatus(repoPath));
  const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"), { readOnly });
  const repository = readOnly
    ? store.findRepository(getRepositoryIdentity(repoPath))
    : store.ensureRepository(getRepositoryIdentity(repoPath));
  if (!repository) {
    store.close();
    throw new Error("Repository graph is not indexed.");
  }
  try {
    const activeGenerationId = store.getActiveGenerationId(repository.id);
    if (status.graph.status === "not_indexed" && !activeGenerationId) {
      throw new Error("Repository graph is not indexed.");
    }
    const frameworkInputs = store.loadFrameworkQueryInputs(repository.id);
    const framework = projectFrameworkGraphWithReliability(frameworkInputs.graph, frameworkInputs.framework, frameworkInputs.reliability, { capability: "framework_repository" }, CURRENT_INDEX_VERSION_DOMAINS.frameworkResolutionVersion);
    return {
      repoPath,
      repoId: repository.id,
      graph: frameworkInputs.graph,
      capabilityState: status.graph.status === "stale" ? "stale" : "ready",
      mayBeIncomplete: status.graph.resolutionCoverage.mayBeIncomplete || status.graph.status === "stale" || framework.mayBeIncomplete,
      framework,
    };
  } finally {
    store.close();
  }
}
