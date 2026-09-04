import path from "node:path";

import { createCliCommandReporter } from "./cli-command-reporter.js";
import { formatIndexFailure, formatIndexResult, formatRepositoryStatus } from "./cli-output.js";
import { getRepositoryStatus } from "../../core/repository/repository-status.service.js";
import { indexRepository, syncRepository } from "../../core/indexing/index-pipeline.service.js";

export async function runIndexingCommand(
  operation: "index" | "sync" | "status",
  args: string[],
  repoPath = path.resolve("."),
): Promise<void> {
  const json = args.includes("--json");
  const explicitPath = args.find((arg) => !arg.startsWith("--"));
  const targetPath = explicitPath ? path.resolve(repoPath, explicitPath) : repoPath;
  if (operation === "status") {
    const result = await getRepositoryStatus(targetPath);
    const reporter = createCliCommandReporter({ json });
    if (json) reporter.output(result);
    else reporter.success(formatRepositoryStatus(result));
    return;
  }
  const index = operation === "index"
    ? indexRepository
    : syncRepository;
  const quiet = args.includes("--quiet");
  const reporter = createCliCommandReporter({ json, quiet });
  reporter.start(operation === "index" ? "CodeAtlas Index" : "CodeAtlas Sync");
  let cancelled = false;
  const onSigint = () => {
    cancelled = true;
    process.exitCode = 130;
    if (json) reporter.output({ cancelled: true, operation });
    else reporter.failure(`! ${operation === "index" ? "Index" : "Sync"} cancelled`);
  };
  process.once("SIGINT", onSigint);

  try {
    const result = await index(targetPath, {
      progress: reporter.progress,
      skipGit: args.includes("--skip-git"),
    });
    if (cancelled || quiet) return;
    if (json) reporter.output(result);
    else reporter.success(formatIndexResult(result));
  } catch (error) {
    if (cancelled) return;
    process.exitCode = 1;
    if (json) {
      reporter.output({ error: error instanceof Error ? error.message : String(error) });
    } else {
      reporter.failure(formatIndexFailure(operation, error));
      if (process.env.DEBUG) process.stderr.write(`${error instanceof Error ? error.stack ?? "" : ""}\n`);
    }
  } finally {
    process.off("SIGINT", onSigint);
  }
}
