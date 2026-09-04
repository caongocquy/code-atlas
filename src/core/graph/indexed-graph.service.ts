import path from "node:path";

import { AtlasStore } from "../../storage/atlas/atlas.store.js";
import { getRepositoryStatus } from "../repository/repository-status.service.js";
import {
  canonicalRepositoryPath,
  getRepositoryIdentity,
} from "../repository/repository-identity.js";
import type { CodeGraph } from "./types.js";

export type IndexedGraph = {
  repoPath: string;
  repoId: string;
  graph: CodeGraph;
  capabilityState: "ready" | "stale";
  mayBeIncomplete: boolean;
};

export async function loadIndexedGraph(inputPath: string): Promise<IndexedGraph> {
  const repoPath = canonicalRepositoryPath(path.resolve(inputPath));
  const status = await getRepositoryStatus(repoPath);

  if (status.graph.status === "not-indexed") {
    throw new Error("Repository graph is not indexed.");
  }

  const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
  const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
  try {
    return {
      repoPath,
      repoId: repository.id,
      graph: store.loadGraph(repository.id),
      capabilityState: status.graph.status === "stale" ? "stale" : "ready",
      mayBeIncomplete: status.graph.resolutionCoverage.mayBeIncomplete || status.graph.status === "stale",
    };
  } finally {
    store.close();
  }
}
