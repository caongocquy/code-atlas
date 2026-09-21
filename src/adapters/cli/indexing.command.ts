import path from "node:path";

import { createCliCommandReporter } from "./cli-command-reporter.js";
import { createInlineProgressRunner } from "./cli-progress-reporter.js";
import { formatIndexFailure, formatIndexResult, formatRepositoryStatus } from "./cli-output.js";
import { getRepositoryStatusReadOnly } from "../../core/repository/repository-status.service.js";
import { indexRepository, syncRepository, type IndexPipelineResult } from "../../core/indexing/index-pipeline.service.js";
import { createConfiguredProviders, closeConfiguredProviders } from "../../infrastructure/semantic/repository-providers.js";
import { readRepositoryConfig } from "../../infrastructure/semantic/semantic-config.store.js";
import type { DefaultProviderSet } from "../../infrastructure/provider-defaults.js";

export async function runIndexingCommand(
  operation: "index" | "sync" | "status",
  args: string[],
  repoPath = path.resolve("."),
): Promise<void> {
  const json = args.includes("--json");
  const explicitPath = args.find((arg) => !arg.startsWith("--"));
  const targetPath = explicitPath ? path.resolve(repoPath, explicitPath) : repoPath;
  if (operation === "status") {
    const result = await getRepositoryStatusReadOnly(targetPath);
    const reporter = createCliCommandReporter({ command: "status", json });
    if (json) reporter.output(result);
    else reporter.success(formatRepositoryStatus(result));
    return;
  }
  const index = operation === "index"
    ? indexRepository
    : syncRepository;
  const quiet = args.includes("--quiet");
  const reporter = createCliCommandReporter({ command: operation === "sync" ? "sync" : "index", json, quiet });
  reporter.start(operation === "index" ? "CodeAtlas Index" : "CodeAtlas Sync");
  let cancelled = false;
  const onSigint = () => {
    cancelled = true;
    process.exitCode = 130;
    if (json) reporter.output({ cancelled: true, operation });
    else reporter.failure(`! ${operation === "index" ? "Index" : "Sync"} cancelled`);
  };
  process.once("SIGINT", onSigint);
  let providers: DefaultProviderSet | undefined;

  try {
    const config = await readRepositoryConfig(targetPath);
    const includeSemantic = config.semantic?.enabled === true;
    if (includeSemantic) providers = await createConfiguredProviders(targetPath);
    const result = await reporter.run(
      operation === "index" ? "Indexing repository" : "Syncing repository",
      (progressReporter) => index(targetPath, {
        progress: createInlineProgressRunner(progressReporter),
        skipGit: args.includes("--skip-git"),
        includeSemantic,
        semanticProviders: includeSemantic && providers?.embeddingProvider ? {
          embeddingProvider: providers.embeddingProvider,
          vectorStore: providers.vectorStore,
        } : undefined,
      }),
    );
    if (result.kind === "failed") {
      process.exitCode = 1;
      const error = new Error(result.failure.message);
      if (json) reporter.output({ error: error.message });
      else reporter.failure(formatIndexFailure(operation, error));
      return;
    }
    if (cancelled || quiet) return;
    if (json) reporter.output(result);
    else reporter.success(formatIndexResult(result as IndexPipelineResult));
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
    closeConfiguredProviders(providers);
    process.off("SIGINT", onSigint);
  }
}
