import path from "node:path";

import { cliProgressRunner } from "./cli/progress.js";
import {
  formatIncrementalSync,
  formatNotice,
  formatSummary,
  type SummaryRow,
} from "./cli/format.js";
import { GRAPH_INDEX_VERSION } from "./config/constants.js";
import { indexGraph } from "./services/graph-index.js";

async function main(): Promise<void> {
  const repoPath = path.resolve(process.argv[2] ?? ".");
  const result = await indexGraph(repoPath, { progress: cliProgressRunner });

  if (result.versionChanged) {
    console.log(
      formatNotice(
        "Graph index version changed",
        `${result.storedVersion ?? "none"} → ${GRAPH_INDEX_VERSION}`,
        "warning",
      ),
    );
    console.log(formatNotice("Full rebuild required", undefined, "warning"));
  }

  if (result.status === "current") {
    console.log(
      formatSummary("Graph already up to date", [
        { label: "Files", value: result.files },
        { label: "Unchanged", value: result.unchangedFiles },
        { label: "Version", value: result.version },
        { label: "Time", value: `${result.totalMs.toFixed(1)} ms` },
      ], "graph"),
    );

    return;
  }

  if (!result.fullRebuild) {
    console.log(
      formatNotice(
        "Incremental sync",
        formatIncrementalSync(
          result.addedFiles,
          result.changedFiles,
          result.deletedFiles,
        ),
      ),
    );
  }

  const summaryRows: SummaryRow[] = [
    { label: "Files", value: result.files },
    { label: "Added", value: result.addedFiles, tone: "warning" },
    { label: "Changed", value: result.changedFiles, tone: "warning" },
    { label: "Impacted", value: result.impactedFiles, tone: "warning" },
    { label: "Unchanged", value: result.unchangedFiles },
    { label: "Deleted", value: result.deletedFiles, tone: "warning" },
  ];

  if (result.fullRebuild) {
    summaryRows.push(
      { label: "Nodes", value: result.nodes },
      { label: "Edges", value: result.edges },
    );
  }

  summaryRows.push(
    { label: "Version", value: result.version },
    { label: "Time", value: `${result.totalMs.toFixed(1)} ms` },
  );

  console.log(formatSummary("Graph indexed", summaryRows, "graph"));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
