import path from "node:path";
import { access } from "node:fs/promises";

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
import { buildRepositoryEvidenceState, type RepositoryEvidenceState } from "../repository/repository-evidence-state.js";
import type { MaterializedFileFacts } from "../facts/facts.types.js";
import type { IndexManifest } from "../indexing/index-manifest.js";

export type IndexedGraph = {
  repoPath: string;
  repoId: string;
  graph: CodeGraph;
  capabilityState: "ready" | "stale";
  mayBeIncomplete: boolean;
  evidenceState: RepositoryEvidenceState;
  framework?: FrameworkQueryProjection;
};

export type IndexedMessageGraph = IndexedGraph & {
  sourceFacts: MaterializedFileFacts[];
  factDiagnostics: Array<{ file?: string; code: string }>;
  generationManifest?: IndexManifest;
};

export async function loadIndexedGraph(inputPath: string): Promise<IndexedGraph> {
  return loadIndexedGraphInternal(inputPath, false);
}

export async function loadIndexedGraphReadOnly(inputPath: string): Promise<IndexedGraph> {
  return loadIndexedGraphInternal(inputPath, true);
}

export async function loadIndexedMessageGraphReadOnly(inputPath: string): Promise<IndexedMessageGraph> {
  const repoPath = canonicalRepositoryPath(path.resolve(inputPath));
  const status = await getRepositoryStatusReadOnly(repoPath);
  const databasePath = path.join(repoPath, ".codeatlas", "atlas.db");
  try {
    await access(databasePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("Repository graph is not indexed.", { cause: error });
    }
    throw error;
  }
  const store = new AtlasStore(databasePath, { readOnly: true });
  const repository = store.findRepository(getRepositoryIdentity(repoPath));
  if (!repository) {
    store.close();
    throw new Error("Repository graph is not indexed.");
  }
  try {
    const inputs = store.loadMessageGraphQueryInputs(repository.id);
    if (status.graph.status === "not_indexed" && !inputs.generationId) {
      throw new Error("Repository graph is not indexed.");
    }
    const framework = projectFrameworkGraphWithReliability(inputs.graph, inputs.framework, inputs.reliability, { capability: "framework_repository" }, CURRENT_INDEX_VERSION_DOMAINS.frameworkResolutionVersion);
    return {
      repoPath,
      repoId: repository.id,
      graph: inputs.graph,
      capabilityState: status.graph.status === "stale" ? "stale" : "ready",
      mayBeIncomplete: status.graph.resolutionCoverage.mayBeIncomplete
        || status.graph.status === "stale"
        || framework.mayBeIncomplete
        || inputs.factDiagnostics.length > 0,
      evidenceState: buildRepositoryEvidenceState(repository.id, inputs.generationId, status.graph, framework.mayBeIncomplete),
      framework,
      sourceFacts: inputs.sourceFacts,
      factDiagnostics: inputs.factDiagnostics,
      ...(inputs.generationManifest ? { generationManifest: inputs.generationManifest } : {}),
    };
  } finally {
    store.close();
  }
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
    const frameworkInputs = store.loadFrameworkQueryInputs(repository.id);
    if (status.graph.status === "not_indexed" && !frameworkInputs.generationId) {
      throw new Error("Repository graph is not indexed.");
    }
    const framework = projectFrameworkGraphWithReliability(frameworkInputs.graph, frameworkInputs.framework, frameworkInputs.reliability, { capability: "framework_repository" }, CURRENT_INDEX_VERSION_DOMAINS.frameworkResolutionVersion);
    return {
      repoPath,
      repoId: repository.id,
      graph: frameworkInputs.graph,
      capabilityState: status.graph.status === "stale" ? "stale" : "ready",
      mayBeIncomplete: status.graph.resolutionCoverage.mayBeIncomplete || status.graph.status === "stale" || framework.mayBeIncomplete,
      evidenceState: buildRepositoryEvidenceState(repository.id, frameworkInputs.generationId, status.graph, framework.mayBeIncomplete),
      framework,
    };
  } finally {
    store.close();
  }
}
