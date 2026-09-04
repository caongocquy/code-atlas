import path from "node:path";

import { getRepositoryStatus } from "../../core/repository/repository-status.service.js";
import { indexRepository, syncRepository } from "../../core/indexing/index-pipeline.service.js";
import { silentProgressRunner } from "../../core/progress/silent-progress-runner.js";

export async function runIndexingCommand(
  operation: "index" | "sync" | "status",
  args: string[],
  repoPath = path.resolve("."),
): Promise<void> {
  const explicitPath = args.find((arg) => !arg.startsWith("--"));
  const targetPath = explicitPath ? path.resolve(repoPath, explicitPath) : repoPath;
  if (operation === "status") {
    process.stdout.write(`${JSON.stringify(await getRepositoryStatus(targetPath), null, 2)}\n`);
    return;
  }
  const index = operation === "index"
    ? indexRepository
    : syncRepository;
  const result = await index(targetPath, {
    progress: silentProgressRunner,
    skipGit: args.includes("--skip-git"),
  });
  if (!args.includes("--quiet")) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
