import fs from "node:fs/promises";
import path from "node:path";

import {
  GRAPH_INDEX_VERSION,
  REPO_CODE_COLLECTION,
  VECTOR_INDEX_VERSION,
} from "../../config/constants.js";
import { qdrant } from "../../infrastructure/vector/qdrant.client.js";
import { GraphStore } from "../../storage/graph/graph.store.js";
import { getIndexedFileStates } from "./index-state.service.js";
import { IndexMetadataStore, type IndexMetadata } from "../../storage/metadata/index-metadata.store.js";
import { createFileHash } from "./file-hash.js";
import { getRepoId, scanRepo } from "./repository-files.js";

export type RepositoryStatus = {
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

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function currentHashes(
  repoPath: string,
  files: string[],
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();

  for (const filePath of files) {
    const relativePath = path.relative(repoPath, filePath);
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

function metadataFor(
  metadataStore: IndexMetadataStore | undefined,
  repoId: string,
  type: "vector" | "graph",
): IndexMetadata | undefined {
  return metadataStore?.getMetadata(repoId, type);
}

export async function getRepositoryStatus(
  inputPath = process.cwd(),
): Promise<RepositoryStatus> {
  const repoPath = path.resolve(inputPath);
  const repoId = getRepoId(repoPath);
  const files = await scanRepo(repoPath);
  const hashes = await currentHashes(repoPath, files);
  const metadataPath = path.join(repoPath, ".code-rag", "index-metadata.db");
  const graphPath = path.join(repoPath, ".code-rag", "graph.db");
  const metadataStore = (await exists(metadataPath))
    ? new IndexMetadataStore(metadataPath)
    : undefined;

  try {
    const vectorMetadata = metadataFor(metadataStore, repoId, "vector");
    const graphMetadata = metadataFor(metadataStore, repoId, "graph");
    const vector = await getVectorStatus(repoId, hashes, vectorMetadata);
    const graph = await getGraphStatus(repoId, graphPath, hashes, graphMetadata);

    return {
      repository: {
        path: repoPath,
        repoId,
        sourceFiles: files.length,
      },
      vector,
      graph,
    };
  } finally {
    metadataStore?.close();
  }
}

async function getVectorStatus(
  repoId: string,
  hashes: Map<string, string>,
  metadata: IndexMetadata | undefined,
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

    const states = await getIndexedFileStates(repoId);
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
    const needsSync = base.needsSync || hasChanges(hashes, states);

    return {
      ...base,
      indexedFiles: states.size,
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
  graphPath: string,
  hashes: Map<string, string>,
  metadata: IndexMetadata | undefined,
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
    sqlitePath: graphPath,
    reachable: false,
    needsRebuild: metadata?.version !== GRAPH_INDEX_VERSION,
    updatedAt: metadata?.updatedAt,
  };

  if (!(await exists(graphPath))) {
    return {
      ...base,
      status: "not-indexed",
    };
  }

  const store = new GraphStore(graphPath);

  try {
    const states = store.getFileStates(repoId);
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
  } finally {
    store.close();
  }
}
