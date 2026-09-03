import fs from "node:fs/promises";
import path from "node:path";

import {
  GRAPH_INDEX_VERSION,
  REPO_CODE_COLLECTION,
  VECTOR_INDEX_VERSION,
} from "../../config/constants.js";
import { qdrant } from "../../infrastructure/vector/qdrant.client.js";
import { AtlasStore } from "../../storage/atlas/atlas.store.js";
import type { IndexMetadata } from "../../storage/atlas/atlas.types.js";
import { createFileHash } from "./file-hash.js";
import {
  canonicalRepositoryPath,
  getRepositoryIdentity,
} from "./repository-identity.js";
import {
  repositoryRelativePath,
  scanRepo,
} from "./repository-files.js";
import { detectChangeDetectionMode } from "../indexing/change-detector.js";

export type RepositoryStatus = {
  changeDetection: "git" | "filesystem";
  repository: {
    path: string;
    repoId: string;
    sourceFiles: number;
  };
  vector: {
    currentVersion: string;
    storedVersion?: string;
    indexedFiles: number;
    points: number;
    chunks: number;
    collection: string;
    reachable: boolean;
    status: "ready" | "not-indexed" | "stale" | "unavailable";
    needsSync: boolean;
    updatedAt?: string;
    error?: string;
  };
  graph: {
    currentVersion: string;
    storedVersion?: string;
    indexedFiles: number;
    nodes: number;
    edges: number;
    edgeBreakdown: {
      calls: number;
      imports: number;
      extends: number;
      contains: number;
    };
    sqlitePath: string;
    reachable: boolean;
    status: "ready" | "not-indexed" | "stale";
    needsRebuild: boolean;
    updatedAt?: string;
  };
};

async function currentHashes(
  repoPath: string,
  files: string[],
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();

  for (const filePath of files) {
    const relativePath = repositoryRelativePath(repoPath, filePath);
    hashes.set(relativePath, createFileHash(await fs.readFile(filePath, "utf8")));
  }

  return hashes;
}

function hasChanges(
  current: Map<string, string>,
  indexed: Map<string, { fileHash: string }>,
): boolean {
  if (current.size !== indexed.size) {
    return true;
  }

  for (const [file, hash] of current) {
    if (indexed.get(file)?.fileHash !== hash) {
      return true;
    }
  }

  return false;
}

export async function getRepositoryStatus(
  inputPath = process.cwd(),
): Promise<RepositoryStatus> {
  const repoPath = canonicalRepositoryPath(path.resolve(inputPath));
  const files = await scanRepo(repoPath);
  const hashes = await currentHashes(repoPath, files);
  const changeDetection = await detectChangeDetectionMode(repoPath);
  const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
  const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
  const repoId = repository.id;

  try {
    const vector = await getVectorStatus(
      repoId,
      hashes,
      store.getMetadata(repoId, "semantic"),
      store.getFileCapabilityStates(repoId, "semantic"),
    );
    const graph = await getGraphStatus(
      repoId,
      path.join(repoPath, ".codeatlas", "atlas.db"),
      hashes,
      store.getMetadata(repoId, "graph"),
      store,
    );

    return {
      changeDetection,
      repository: {
        path: repoPath,
        repoId,
        sourceFiles: files.length,
      },
      vector,
      graph,
    };
  } finally {
    store.close();
  }
}

async function getVectorStatus(
  repoId: string,
  hashes: Map<string, string>,
  metadata: IndexMetadata | undefined,
  capabilityStates: Map<string, { fileHash?: string; state: string }>,
): Promise<RepositoryStatus["vector"]> {
  const base = {
    currentVersion: VECTOR_INDEX_VERSION,
    storedVersion: metadata?.version,
    indexedFiles: 0,
    points: 0,
    chunks: 0,
    collection: REPO_CODE_COLLECTION,
    reachable: false,
    needsSync: metadata?.version !== VECTOR_INDEX_VERSION,
    updatedAt: metadata?.updatedAt,
  };

  try {
    const collections = await qdrant.getCollections();
    const collectionExists = collections.collections.some(
      (collection) => collection.name === REPO_CODE_COLLECTION,
    );

    if (!collectionExists) {
      return {
        ...base,
        reachable: true,
        status: "not-indexed",
      };
    }

    const readyStates = new Map(
      Array.from(capabilityStates.entries())
        .filter(([, state]) => state.state === "ready")
        .filter(([, state]) => state.fileHash !== undefined)
        .map(([file, state]) => [file, { fileHash: state.fileHash! }]),
    );
    const count = await qdrant.count(REPO_CODE_COLLECTION, {
      exact: true,
      filter: {
        must: [
          {
            key: "repoId",
            match: {
              value: repoId,
            },
          },
        ],
      },
    });
    const needsSync = base.needsSync || hasChanges(hashes, readyStates);

    return {
      ...base,
      indexedFiles: capabilityStates.size,
      points: count.count,
      chunks: count.count,
      reachable: true,
      needsSync,
      status: needsSync ? "stale" : "ready",
    };
  } catch (error) {
    return {
      ...base,
      status: "unavailable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getGraphStatus(
  repoId: string,
  databasePath: string,
  hashes: Map<string, string>,
  metadata: IndexMetadata | undefined,
  store: AtlasStore,
): Promise<RepositoryStatus["graph"]> {
  const base = {
    currentVersion: GRAPH_INDEX_VERSION,
    storedVersion: metadata?.version,
    indexedFiles: 0,
    nodes: 0,
    edges: 0,
    edgeBreakdown: {
      calls: 0,
      imports: 0,
      extends: 0,
      contains: 0,
    },
    sqlitePath: databasePath,
    reachable: false,
    needsRebuild: metadata?.version !== GRAPH_INDEX_VERSION,
    updatedAt: metadata?.updatedAt,
  };

  const states = store.getFileStates(repoId);

  if (states.size === 0) {
    return {
      ...base,
      status: "not-indexed",
    };
  }

  const graph = store.loadGraph(repoId);
  const edgeBreakdown = {
      calls: graph.edges.filter((edge) => edge.type === "calls").length,
      imports: graph.edges.filter((edge) => edge.type === "imports").length,
      extends: graph.edges.filter((edge) => edge.type === "extends").length,
      contains: graph.edges.filter((edge) => edge.type === "contains").length,
  };
  const needsRebuild = base.needsRebuild || hasChanges(hashes, states);

  return {
    ...base,
    indexedFiles: states.size,
    nodes: graph.nodes.length,
    edges: graph.edges.length,
    edgeBreakdown,
    reachable: true,
    needsRebuild,
    status: needsRebuild ? "stale" : "ready",
  };
}
