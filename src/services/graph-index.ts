import fs from "node:fs/promises";
import path from "node:path";

import type {
  ProgressReporter,
  ProgressRunner,
} from "../cli/types.js";
import { GRAPH_INDEX_VERSION } from "../config/constants.js";
import { buildFileGraphs } from "../graph/build-file-updates.js";
import { buildCodeGraph } from "../graph/build-graph.js";
import {
  GraphStore,
  type GraphFileState,
  type GraphFileUpdate,
} from "../graph/store.js";
import type { CodeGraph } from "../graph/types.js";
import { IndexMetadataStore } from "./index-metadata.js";
import { silentProgressRunner } from "./progress.js";
import { createFileHash } from "../utils/file-hash.js";
import { getRepoId, scanRepo } from "../utils/repo.js";
import { graphRefreshMode } from "../utils/index-version.js";

export type GraphIndexOptions = {
  progress?: ProgressRunner;
};

export type GraphIndexResult = {
  repoPath: string;
  repoId: string;
  status: "indexed" | "current";
  storedVersion?: string;
  version: string;
  versionChanged: boolean;
  fullRebuild: boolean;
  files: number;
  addedFiles: number;
  changedFiles: number;
  unchangedFiles: number;
  deletedFiles: number;
  impactedFiles: number;
  nodes: number;
  edges: number;
  totalMs: number;
};

function findImporters(
  graph: CodeGraph,
  targetFiles: Set<string>,
): Set<string> {
  const nodeById = new Map(graph.nodes.map((node) => [node.id, node]));
  const importers = new Set<string>();

  for (const edge of graph.edges) {
    if (edge.type !== "imports") {
      continue;
    }

    const from = nodeById.get(edge.from);
    const to = nodeById.get(edge.to);

    if (from && to && targetFiles.has(to.file)) {
      importers.add(from.file);
    }
  }

  return importers;
}

function assertUniqueNodeIds(graph: CodeGraph): void {
  const nodeById = new Map<string, typeof graph.nodes>();

  for (const node of graph.nodes) {
    const nodes = nodeById.get(node.id);

    if (nodes) {
      nodes.push(node);
    } else {
      nodeById.set(node.id, [node]);
    }
  }

  const duplicates = Array.from(nodeById.values()).filter(
    (nodes) => nodes.length > 1,
  );

  if (duplicates.length > 0) {
    throw new Error(`Duplicate graph node IDs detected: ${duplicates.length}`);
  }
}

async function createFileHashes(
  repoPath: string,
  files: string[],
  reporter?: ProgressReporter,
): Promise<Map<string, string>> {
  const hashes = new Map<string, string>();

  for (let index = 0; index < files.length; index += 1) {
    const absoluteFile = files[index];

    if (!absoluteFile) {
      continue;
    }

    const relativeFile = path.relative(repoPath, absoluteFile);
    const content = await fs.readFile(absoluteFile, "utf8");

    hashes.set(relativeFile, createFileHash(content));
    reporter?.setProgress(index + 1, files.length);
  }

  return hashes;
}

export async function indexGraph(
  inputPath: string,
  options: GraphIndexOptions = {},
): Promise<GraphIndexResult> {
  const repoPath = path.resolve(inputPath);
  const progress = options.progress ?? silentProgressRunner;
  const repoId = getRepoId(repoPath);
  const startedAt = performance.now();

  const files = await progress.run(
    "Scanning repository",
    async (reporter) => {
      const scannedFiles = await scanRepo(repoPath);
      reporter.update(`${scannedFiles.length} found`);
      return scannedFiles;
    },
    "graph",
  );
  const relativeFiles = files.map((filePath) => path.relative(repoPath, filePath));
  const currentFileSet = new Set(relativeFiles);
  const currentHashes = await progress.run(
    "Hashing files",
    (reporter) => createFileHashes(repoPath, files, reporter),
    "graph",
  );

  const store = new GraphStore(path.join(repoPath, ".code-rag", "graph.db"));
  const metadataStore = new IndexMetadataStore(
    path.join(repoPath, ".code-rag", "index-metadata.db"),
  );

  try {
    let storedIndexVersion: string | undefined;
    let forceFullRebuild = false;
    let previousStates = new Map<string, GraphFileState>();
    let previousGraph: CodeGraph = { nodes: [], edges: [] };
    const addedFiles: string[] = [];
    const changedFiles: string[] = [];
    const unchangedFiles: string[] = [];
    let deletedFiles: string[] = [];
    let impactedFiles = new Set<string>();

    await progress.run(
      "Loading graph state",
      async (reporter) => {
        storedIndexVersion = metadataStore.getVersion(repoId, "graph");
        forceFullRebuild =
          graphRefreshMode(storedIndexVersion, GRAPH_INDEX_VERSION) === "full-rebuild";

        if (!forceFullRebuild) {
          previousStates = store.getFileStates(repoId);
          previousGraph = store.loadGraph(repoId);
        }

        for (const relativeFile of relativeFiles) {
          const fileHash = currentHashes.get(relativeFile);

          if (!fileHash) {
            throw new Error(`Missing file hash: ${relativeFile}`);
          }

          const previous = previousStates.get(relativeFile);

          if (!previous) {
            addedFiles.push(relativeFile);
          } else if (previous.fileHash !== fileHash) {
            changedFiles.push(relativeFile);
          } else {
            unchangedFiles.push(relativeFile);
          }
        }

        deletedFiles = Array.from(previousStates.keys()).filter(
          (file) => !currentFileSet.has(file),
        );

        const directChanges = new Set([
          ...addedFiles,
          ...changedFiles,
          ...deletedFiles,
        ]);
        const importers = findImporters(previousGraph, directChanges);

        impactedFiles = new Set([
          ...addedFiles,
          ...changedFiles,
          ...Array.from(importers).filter((file) => currentFileSet.has(file)),
        ]);

        if (!forceFullRebuild && impactedFiles.size === 0 && deletedFiles.length === 0) {
          reporter.setTitle?.("Checking index state");
          reporter.update(`${unchangedFiles.length} unchanged`);
        }
      },
      "graph",
    );

    if (forceFullRebuild) {
      let graph: CodeGraph | undefined;

      await progress.runAll([
        {
          title: "Building CodeGraph",
          kind: "graph",
          work: async (reporter) => {
            graph = await buildCodeGraph(repoPath, reporter);
            assertUniqueNodeIds(graph);
          },
        },
        {
          title: "Writing SQLite",
          kind: "graph",
          work: async () => {
            if (!graph) {
              throw new Error("Graph build produced no graph");
            }

            store.replaceGraph(repoId, graph, currentHashes);
            metadataStore.setVersion(repoId, "graph", GRAPH_INDEX_VERSION);
          },
        },
      ]);

      return {
        repoPath,
        repoId,
        status: "indexed",
        storedVersion: storedIndexVersion,
        version: GRAPH_INDEX_VERSION,
        versionChanged: true,
        fullRebuild: true,
        files: relativeFiles.length,
        addedFiles: addedFiles.length,
        changedFiles: changedFiles.length,
        unchangedFiles: 0,
        deletedFiles: deletedFiles.length,
        impactedFiles: relativeFiles.length,
        nodes: graph?.nodes.length ?? 0,
        edges: graph?.edges.length ?? 0,
        totalMs: performance.now() - startedAt,
      };
    }

    if (impactedFiles.size === 0 && deletedFiles.length === 0) {
      return {
        repoPath,
        repoId,
        status: "current",
        storedVersion: storedIndexVersion,
        version: GRAPH_INDEX_VERSION,
        versionChanged: false,
        fullRebuild: false,
        files: relativeFiles.length,
        addedFiles: addedFiles.length,
        changedFiles: changedFiles.length,
        unchangedFiles: unchangedFiles.length,
        deletedFiles: deletedFiles.length,
        impactedFiles: 0,
        nodes: previousGraph.nodes.length,
        edges: previousGraph.edges.length,
        totalMs: performance.now() - startedAt,
      };
    }

    const impactedList = Array.from(impactedFiles);
    let builtFiles: Awaited<ReturnType<typeof buildFileGraphs>> = [];

    await progress.runAll([
      {
        title: "Building CodeGraph",
        kind: "graph",
        work: async (reporter) => {
          builtFiles = await buildFileGraphs(
            repoPath,
            repoId,
            impactedList,
            currentFileSet,
            previousGraph,
            reporter,
          );
        },
      },
      {
        title: "Writing SQLite",
        kind: "graph",
        work: async () => {
          const updates: GraphFileUpdate[] = builtFiles.map((built) => {
            const fileHash = currentHashes.get(built.file);

            if (!fileHash) {
              throw new Error(`Missing file hash: ${built.file}`);
            }

            return {
              file: built.file,
              fileHash,
              nodes: built.nodes,
              edges: built.edges,
            };
          });

          store.applyFileUpdates(repoId, updates, deletedFiles);
        },
      },
    ]);

    const finalGraph = store.loadGraph(repoId);

    return {
      repoPath,
      repoId,
      status: "indexed",
      storedVersion: storedIndexVersion,
      version: GRAPH_INDEX_VERSION,
      versionChanged: false,
      fullRebuild: false,
      files: relativeFiles.length,
      addedFiles: addedFiles.length,
      changedFiles: changedFiles.length,
      unchangedFiles: unchangedFiles.length,
      deletedFiles: deletedFiles.length,
      impactedFiles: impactedList.length,
      nodes: finalGraph.nodes.length,
      edges: finalGraph.edges.length,
      totalMs: performance.now() - startedAt,
    };
  } finally {
    metadataStore.close();
    store.close();
  }
}

export const syncGraph = indexGraph;
