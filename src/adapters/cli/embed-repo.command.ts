import path from "node:path";

import { cliProgressRunner } from "./cli-progress-reporter.js";
import { formatNotice, formatSummary, type SummaryRow } from "./cli-output.js";
import {
  EMBEDDING_BATCH_SIZE,
  UPSERT_BATCH_SIZE,
} from "../../config/constants.js";
import { indexSemantic } from "../../core/semantic/semantic-index.service.js";
import { defaultProviders } from "../../infrastructure/provider-defaults.js";

async function main(): Promise<void> {
  const repoPath = path.resolve(process.argv[2] ?? ".");
  const result = await indexSemantic(repoPath, {
    progress: cliProgressRunner,
    embeddingProvider: defaultProviders.embeddingProvider,
    vectorStore: defaultProviders.vectorStore,
  });

  if (result.fullReindex) {
    console.log(
      formatNotice(
        "Vector index version changed",
        `${result.storedVersion ?? "none"} → ${result.version}`,
        "warning",
      ),
    );
    console.log(formatNotice("Full reindex required", undefined, "warning"));
  }

  const title = result.status === "nothing-to-index"
    ? "Nothing to index"
    : "Vector indexed";
  const rows: SummaryRow[] = [
    { label: "Files", value: result.files },
  ];

  if (result.status !== "nothing-to-index") {
    rows.push(
      { label: "Chunks", value: result.chunks },
      { label: "Points", value: result.points },
      { label: "Embedded", value: result.embeddedSymbols },
      { label: "Cleaned points", value: result.cleanedOldPoints },
    );
  }

  rows.push({ label: "Version", value: result.version });

  if (result.status !== "nothing-to-index") {
    rows.push(
      {
        label: "Full reindex",
        value: result.fullReindex ? "yes" : "no",
        tone: result.fullReindex ? "warning" : "muted",
      },
      { label: "Embedding batches", value: result.embeddingBatches },
      { label: "Embedding batch size", value: EMBEDDING_BATCH_SIZE },
      { label: "Qdrant batches", value: result.qdrantBatches },
      { label: "Qdrant batch size", value: UPSERT_BATCH_SIZE },
    );
  }

  rows.push(
    { label: "Added", value: result.addedFiles, tone: "warning" },
    { label: "Updated", value: result.updatedFiles, tone: "warning" },
    { label: "Skipped", value: result.skippedFiles },
    { label: "Deleted", value: result.deletedFiles, tone: "warning" },
    { label: "Time", value: `${result.totalMs.toFixed(1)} ms` },
  );

  console.log(
    formatSummary(title, rows, "vector"),
  );
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
