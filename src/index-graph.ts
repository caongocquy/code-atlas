import fs from "node:fs/promises";
import path from "node:path";

import {
  createProgressTask,
  runProgressTask,
  runProgressTasks,
} from "./cli/progress.js";
import {
  formatIncrementalSync,
  formatNotice,
  formatSummary,
} from "./cli/format.js";
import type { ProgressReporter } from "./cli/types.js";
import { GRAPH_INDEX_VERSION } from "./config/constants.js";
import { buildFileGraphs } from "./graph/build-file-updates.js";
import { buildCodeGraph } from "./graph/build-graph.js";
import {
  GraphStore,
  type GraphFileState,
  type GraphFileUpdate,
} from "./graph/store.js";
import type { CodeGraph } from "./graph/types.js";
import { IndexMetadataStore } from "./services/index-metadata.js";
import { createFileHash } from "./utils/file-hash.js";
import { getRepoId, scanRepo } from "./utils/repo.js";
import { graphRefreshMode } from "./utils/index-version.js";

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

  const duplicates = Array.from(nodeById.entries()).filter(
    ([, nodes]) => nodes.length > 1,
  );

  if (duplicates.length === 0) {
    return;
  }

  console.error(`Duplicate graph node IDs: ${duplicates.length}`);

  for (const [id, nodes] of duplicates) {
    console.error("\nDuplicate ID:", id);

    for (const node of nodes) {
      console.error({
        type: node.type,
        name: node.name,
        qualifiedName: node.qualifiedName,
        file: node.file,
        startLine: node.startLine,
        endLine: node.endLine,
      });
    }
  }

  throw new Error("Duplicate graph node IDs detected");
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

async function main(): Promise<void> {
  const repoPath = path.resolve(process.argv[2] ?? ".");
  const repoId = getRepoId(repoPath);
  const startedAt = performance.now();

  const files = await runProgressTask("Scanning repository", async (reporter) => {
    const scannedFiles = await scanRepo(repoPath);
    reporter.update(`${scannedFiles.length} found`);
    return scannedFiles;
  }, "graph");
  const relativeFiles = files.map((filePath) => path.relative(repoPath, filePath));
  const currentFileSet = new Set(relativeFiles);
  const currentHashes = await runProgressTask("Hashing files", (reporter) =>
    createFileHashes(repoPath, files, reporter),
  "graph");

  const store = new GraphStore();
  const metadataStore = new IndexMetadataStore();

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

    await runProgressTask("Loading graph state", async (reporter) => {
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
    }, "graph");

    if (forceFullRebuild) {
      console.log(
        formatNotice(
          "Graph index version changed",
          `${storedIndexVersion ?? "none"} → ${GRAPH_INDEX_VERSION}`,
          "warning",
        ),
      );
      console.log(formatNotice("Full rebuild required", undefined, "warning"));

      let graph: CodeGraph | undefined;

      await runProgressTasks([
        createProgressTask("Building CodeGraph", async (reporter) => {
          graph = await buildCodeGraph(repoPath, reporter);
          assertUniqueNodeIds(graph);
        }, "graph"),
        createProgressTask("Writing SQLite", async () => {
          if (!graph) {
            throw new Error("Graph build produced no graph");
          }

          store.replaceGraph(repoId, graph, currentHashes);
          metadataStore.setVersion(repoId, "graph", GRAPH_INDEX_VERSION);
        }, "graph"),
      ]);

      const totalMs = performance.now() - startedAt;

      console.log(
        formatSummary("Graph indexed", [
          { label: "Files", value: relativeFiles.length },
          { label: "Added", value: addedFiles.length, tone: "warning" },
          { label: "Changed", value: changedFiles.length, tone: "warning" },
          { label: "Impacted", value: relativeFiles.length, tone: "warning" },
          { label: "Unchanged", value: 0 },
          { label: "Deleted", value: deletedFiles.length, tone: "warning" },
          { label: "Nodes", value: graph?.nodes.length ?? 0 },
          { label: "Edges", value: graph?.edges.length ?? 0 },
          { label: "Version", value: GRAPH_INDEX_VERSION },
          { label: "Time", value: `${totalMs.toFixed(1)} ms` },
        ], "graph"),
      );

      return;
    }

    if (impactedFiles.size === 0 && deletedFiles.length === 0) {
      const totalMs = performance.now() - startedAt;

      console.log(
        formatSummary("Graph already up to date", [
          { label: "Files", value: relativeFiles.length },
          { label: "Unchanged", value: unchangedFiles.length },
          { label: "Version", value: GRAPH_INDEX_VERSION },
          { label: "Time", value: `${totalMs.toFixed(1)} ms` },
        ], "graph"),
      );

      return;
    }

    const impactedList = Array.from(impactedFiles);
    let builtFiles: Awaited<ReturnType<typeof buildFileGraphs>> = [];

    console.log(
      formatNotice(
        "Incremental sync",
        formatIncrementalSync(
          addedFiles.length,
          changedFiles.length,
          deletedFiles.length,
        ),
      ),
    );

    await runProgressTasks([
      createProgressTask("Building CodeGraph", async (reporter) => {
        builtFiles = await buildFileGraphs(
          repoPath,
          repoId,
          impactedList,
          currentFileSet,
          previousGraph,
          reporter,
        );
      }, "graph"),
      createProgressTask("Writing SQLite", async () => {
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
      }, "graph"),
    ]);

    const totalMs = performance.now() - startedAt;

    console.log(
      formatSummary("Graph indexed", [
        { label: "Files", value: relativeFiles.length },
        { label: "Added", value: addedFiles.length, tone: "warning" },
        { label: "Changed", value: changedFiles.length, tone: "warning" },
        { label: "Impacted", value: impactedList.length, tone: "warning" },
        { label: "Unchanged", value: unchangedFiles.length },
        { label: "Deleted", value: deletedFiles.length, tone: "warning" },
        { label: "Version", value: GRAPH_INDEX_VERSION },
        { label: "Time", value: `${totalMs.toFixed(1)} ms` },
      ], "graph"),
    );
  } finally {
    metadataStore.close();
    store.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
