import path from "node:path";

import { cliProgressRunner } from "./cli-progress-reporter.js";
import {
  formatIncrementalSync,
  formatNotice,
  formatSummary,
  type SummaryRow,
} from "./cli-output.js";
import { GRAPH_INDEX_VERSION } from "../../config/constants.js";
import { syncRepository, type IndexPipelineResult } from "../../core/indexing/index-pipeline.service.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const repoArgument = args.find((argument) => argument !== "--skip-git") ?? ".";
  const repoPath = path.resolve(repoArgument);
  const result = await syncRepository(repoPath, {
    progress: cliProgressRunner,
    skipGit: args.includes("--skip-git"),
  });
  if (result.kind === "failed") throw new Error(result.failure.message);
  const graph = (result as IndexPipelineResult).graph;

  if (graph.versionChanged) {
    console.log(
      formatNotice(
        "Graph index version changed",
        `${graph.storedVersion ?? "none"} → ${GRAPH_INDEX_VERSION}`,
        "warning",
      ),
    );
    console.log(formatNotice("Full rebuild required", undefined, "warning"));
  }

  if (graph.status === "current") {
    console.log(
      formatSummary("Graph already up to date", [
        { label: "Files", value: graph.files },
        { label: "Unchanged", value: graph.unchangedFiles },
        { label: "Version", value: graph.version },
        { label: "Time", value: `${graph.totalMs.toFixed(1)} ms` },
      ], "graph"),
    );

    return;
  }

  if (!graph.fullRebuild) {
    console.log(
      formatNotice(
        "Incremental sync",
        formatIncrementalSync(
          graph.addedFiles,
          graph.changedFiles,
          graph.deletedFiles,
        ),
      ),
    );
  }

  const summaryRows: SummaryRow[] = [
    { label: "Files", value: graph.files },
    { label: "Added", value: graph.addedFiles, tone: "warning" },
    { label: "Changed", value: graph.changedFiles, tone: "warning" },
    { label: "Impacted", value: graph.impactedFiles, tone: "warning" },
    { label: "Unchanged", value: graph.unchangedFiles },
    { label: "Deleted", value: graph.deletedFiles, tone: "warning" },
  ];

  if (graph.fullRebuild) {
    summaryRows.push(
      { label: "Nodes", value: graph.nodes },
      { label: "Edges", value: graph.edges },
    );
  }

  summaryRows.push(
    { label: "Version", value: graph.version },
    { label: "Time", value: `${graph.totalMs.toFixed(1)} ms` },
  );

  console.log(formatSummary("Graph indexed", summaryRows, "graph"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
