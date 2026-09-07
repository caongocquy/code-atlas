import fs from "node:fs/promises";
import path from "node:path";

import {
  GRAPH_INDEX_VERSION,
  LEXICAL_INDEX_VERSION,
  VECTOR_INDEX_VERSION,
} from "../../config/constants.js";
import { AtlasStore } from "../../storage/atlas/atlas.store.js";
import type {
  AtlasFileCapabilityState,
  CapabilityState,
  IndexMetadata,
} from "../../storage/atlas/atlas.types.js";
import type { EmbeddingProvider } from "../semantic/embedding-provider.js";
import type { VectorStore } from "../semantic/vector-store.js";
import type { RerankerProvider } from "../retrieval/reranker-provider.js";
import { emptyResolutionCoverage, type ResolutionCoverage } from "../graph/resolution.types.js";
import {
  embeddingProviderIdentity,
  hasVectorStoreGeneration,
} from "../semantic/provider-identity.js";
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
  capabilities: {
    graph: CapabilitySummary;
    lexical: CapabilitySummary;
    semantic: CapabilitySummary;
    reranker: CapabilitySummary;
  };
  vector: {
    currentVersion: string;
    storedVersion?: string;
    indexedFiles: number;
    points: number;
    chunks: number;
    backend: string;
    reachable: boolean;
    status: CapabilityState;
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
    resolutionCoverage: ResolutionCoverage;
    sqlitePath: string;
    reachable: boolean;
    status: CapabilityState;
    needsRebuild: boolean;
    updatedAt?: string;
  };
};

export type RepositoryStatusProviders = {
  embeddingProvider?: EmbeddingProvider;
  vectorStore?: VectorStore;
  rerankerProvider?: RerankerProvider;
};

export type CapabilitySummary = {
  state: CapabilityState;
  version?: string;
  storedVersion?: string;
  indexedFiles: number;
  itemCount: number;
  updatedAt?: string;
  lastError?: string;
};

function emptyStatus(
  repoPath: string,
  sourceFiles: number,
  changeDetection: RepositoryStatus["changeDetection"],
): RepositoryStatus {
  const repoId = getRepositoryIdentity(repoPath).id;
  return {
    changeDetection,
    repository: { path: repoPath, repoId, sourceFiles },
    capabilities: {
      graph: { state: "not_indexed", indexedFiles: 0, itemCount: 0 },
      lexical: { state: "not_indexed", indexedFiles: 0, itemCount: 0 },
      semantic: { state: "not_configured", indexedFiles: 0, itemCount: 0 },
      reranker: { state: "not_configured", indexedFiles: 0, itemCount: 0 },
    },
    vector: {
      currentVersion: VECTOR_INDEX_VERSION,
      indexedFiles: 0,
      points: 0,
      chunks: 0,
      backend: "sqlite",
      reachable: false,
      status: "not_indexed",
      needsSync: false,
    },
    graph: {
      currentVersion: GRAPH_INDEX_VERSION,
      indexedFiles: 0,
      nodes: 0,
      edges: 0,
      edgeBreakdown: { calls: 0, imports: 0, extends: 0, contains: 0 },
      resolutionCoverage: emptyResolutionCoverage(),
      sqlitePath: path.join(repoPath, ".codeatlas", "atlas.db"),
      reachable: false,
      status: "not_indexed",
      needsRebuild: false,
    },
  };
}

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

function latestUpdatedAt(
  states: Map<string, AtlasFileCapabilityState>,
): string | undefined {
  return Array.from(states.values())
    .map((state) => state.updatedAt)
    .sort()
    .at(-1);
}

function capabilityFromFiles(
  states: Map<string, AtlasFileCapabilityState>,
  metadata: IndexMetadata | undefined,
  currentVersion: string,
  hashes: Map<string, string>,
): CapabilitySummary {
  const itemCount = Array.from(states.values()).reduce(
    (total, state) => total + state.itemCount,
    0,
  );
  const error = Array.from(states.values()).find((state) => state.state === "error");
  const staleState = Array.from(states.values()).find((state) => state.state === "stale");
  const explicitState = Array.from(states.values()).find(
    (state) => state.state === "disabled" || state.state === "unavailable",
  );
  const readyStates = new Map(
    Array.from(states.entries())
      .filter(([, state]) => state.state === "ready" && state.fileHash !== undefined)
      .map(([file, state]) => [file, { fileHash: state.fileHash! }]),
  );
  const hasPersistedIndex = metadata !== undefined || states.size > 0;
  let state: CapabilityState = hasPersistedIndex ? "ready" : "not_indexed";

  if (error) {
    state = "error";
  } else if (explicitState) {
    state = explicitState.state;
  } else if (!hasPersistedIndex) {
    state = "not_indexed";
  } else if (staleState) {
    state = "stale";
  } else if (metadata?.version !== currentVersion || hasChanges(hashes, readyStates)) {
    state = "stale";
  } else if (states.size > 0 && readyStates.size === states.size) {
    state = "ready";
  }

  return {
    state,
    version: currentVersion,
    storedVersion: metadata?.version,
    indexedFiles: states.size,
    itemCount,
    updatedAt: latestUpdatedAt(states) ?? metadata?.updatedAt,
    lastError: error?.lastError,
  };
}

async function getSemanticCapability(
  repoId: string,
  hashes: Map<string, string>,
  store: AtlasStore,
  providers: RepositoryStatusProviders,
): Promise<CapabilitySummary> {
  const metadata = store.getMetadata(repoId, "semantic");
  const states = store.getFileCapabilityStates(repoId, "semantic");
  const base = capabilityFromFiles(states, metadata, VECTOR_INDEX_VERSION, hashes);
  const provider = providers.embeddingProvider;

  if (!provider || !providers.vectorStore) {
    return { ...base, state: "not_configured" };
  }

  try {
    if (!(await provider.isAvailable()) || !(await providers.vectorStore.isAvailable())) {
      return { ...base, state: "unavailable" };
    }
  } catch (error) {
    return {
      ...base,
      state: "unavailable",
      lastError: error instanceof Error ? error.message : String(error),
    };
  }

  const identity = embeddingProviderIdentity(provider);
  const incompatible = Array.from(states.values()).some(
    (state) => state.state === "ready" && (
      state.providerIdentity !== identity ||
      !hasVectorStoreGeneration(state.generation, providers.vectorStore!.id)
    ),
  );

  if (incompatible) {
    return { ...base, state: "stale" };
  }

  return base;
}

async function getRerankerCapability(
  repoId: string,
  store: AtlasStore,
  providers: RepositoryStatusProviders,
): Promise<CapabilitySummary> {
  const states = store.getFileCapabilityStates(repoId, "reranker");
  const persisted = Array.from(states.values()).find(
    (state) => state.state === "error" || state.state === "disabled" || state.state === "stale",
  );

  if (persisted) {
    return {
      state: persisted.state,
      indexedFiles: states.size,
      itemCount: states.size,
      updatedAt: persisted.updatedAt,
      lastError: persisted.lastError,
    };
  }

  if (!providers.rerankerProvider) {
    return { state: "not_configured", indexedFiles: 0, itemCount: 0 };
  }

  try {
    return {
      state: (await providers.rerankerProvider.isAvailable()) ? "ready" : "unavailable",
      indexedFiles: 0,
      itemCount: 0,
    };
  } catch (error) {
    return {
      state: "unavailable",
      indexedFiles: 0,
      itemCount: 0,
      lastError: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getCapabilitySummaries(
  repoId: string,
  hashes: Map<string, string>,
  store: AtlasStore,
  providers: RepositoryStatusProviders,
): Promise<RepositoryStatus["capabilities"]> {
  const graphStates = store.getFileCapabilityStates(repoId, "graph");
  const lexicalStates = store.getFileCapabilityStates(repoId, "lexical");

  return {
    graph: capabilityFromFiles(
      graphStates,
      store.getMetadata(repoId, "graph"),
      GRAPH_INDEX_VERSION,
      hashes,
    ),
    lexical: capabilityFromFiles(
      lexicalStates,
      store.getMetadata(repoId, "lexical"),
      LEXICAL_INDEX_VERSION,
      hashes,
    ),
    semantic: await getSemanticCapability(repoId, hashes, store, providers),
    reranker: await getRerankerCapability(repoId, store, providers),
  };
}

export async function getRepositoryStatus(
  inputPath = process.cwd(),
  providers: RepositoryStatusProviders = {},
  options: { readOnly?: boolean } = {},
): Promise<RepositoryStatus> {
  const repoPath = canonicalRepositoryPath(path.resolve(inputPath));
  const files = await scanRepo(repoPath);
  const hashes = await currentHashes(repoPath, files);
  const changeDetection = await detectChangeDetectionMode(repoPath);
  const databasePath = path.join(repoPath, ".codeatlas", "atlas.db");
  if (options.readOnly) {
    try {
      await fs.access(databasePath);
    } catch {
      return emptyStatus(repoPath, files.length, changeDetection);
    }
  }
  const store = new AtlasStore(databasePath, options);
  const repository = options.readOnly
    ? store.findRepository(getRepositoryIdentity(repoPath))
    : store.ensureRepository(getRepositoryIdentity(repoPath));
  if (!repository) {
    store.close();
    return emptyStatus(repoPath, files.length, changeDetection);
  }
  const repoId = repository.id;

  try {
    const graph = await getGraphStatus(
      repoId,
      path.join(repoPath, ".codeatlas", "atlas.db"),
      hashes,
      store.getMetadata(repoId, "graph"),
      store,
    );
    const capabilities = await getCapabilitySummaries(
      repoId,
      hashes,
      store,
      providers,
    );
    const vector = await getVectorStatus(
      repoId,
      store,
      hashes,
      store.getMetadata(repoId, "semantic"),
      store.getFileCapabilityStates(repoId, "semantic"),
      capabilities.semantic.state,
      providers.vectorStore,
    );

    return {
      changeDetection,
      repository: {
        path: repoPath,
        repoId,
        sourceFiles: files.length,
      },
      capabilities,
      vector,
      graph,
    };
  } finally {
    store.close();
  }
}

export async function getRepositoryStatusReadOnly(
  inputPath = process.cwd(),
  providers: RepositoryStatusProviders = {},
): Promise<RepositoryStatus> {
  return getRepositoryStatus(inputPath, providers, { readOnly: true });
}

async function getVectorStatus(
  repoId: string,
  store: AtlasStore,
  hashes: Map<string, string>,
  metadata: IndexMetadata | undefined,
  capabilityStates: Map<string, { fileHash?: string; state: string }>,
  semanticState: CapabilityState,
  vectorStore?: VectorStore,
): Promise<RepositoryStatus["vector"]> {
  const base = {
    currentVersion: VECTOR_INDEX_VERSION,
    storedVersion: metadata?.version,
    indexedFiles: 0,
    points: 0,
    chunks: 0,
    backend: vectorStore?.id ?? "sqlite",
    reachable: false,
    needsSync: false,
    updatedAt: metadata?.updatedAt,
  };

  try {
    if (vectorStore && !(await vectorStore.isAvailable())) {
      return {
        ...base,
        status: "unavailable",
      };
    }

    const readyStates = new Map(
      Array.from(capabilityStates.entries())
        .filter(([, state]) => state.state === "ready")
        .filter(([, state]) => state.fileHash !== undefined)
        .map(([file, state]) => [file, { fileHash: state.fileHash! }]),
    );
    const count = vectorStore
      ? await vectorStore.count(repoId)
      : store.countSemanticVectors(repoId);
    const hasPersistedIndex = metadata !== undefined || capabilityStates.size > 0 || count > 0;
    const semanticCanSync = semanticState !== "not_configured" &&
      semanticState !== "unavailable" && semanticState !== "disabled";
    const isStale = hasPersistedIndex && (
      metadata?.version !== VECTOR_INDEX_VERSION || hasChanges(hashes, readyStates)
    );
    const needsSync = semanticCanSync && isStale;
    const status = !hasPersistedIndex
      ? "not_indexed"
      : isStale
        ? "stale"
        : "ready";

    return {
      ...base,
      indexedFiles: capabilityStates.size,
      points: count,
      chunks: count,
      reachable: true,
      needsSync,
      status,
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
    resolutionCoverage: store.getGraphResolutionCoverage(repoId),
    sqlitePath: databasePath,
    reachable: false,
    needsRebuild: metadata?.version !== GRAPH_INDEX_VERSION,
    updatedAt: metadata?.updatedAt,
  };

  const states = store.getFileStates(repoId);

  if (states.size === 0) {
    return {
      ...base,
      status: "not_indexed",
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
