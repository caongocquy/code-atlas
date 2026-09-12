import path from "node:path";

import { createCliCommandReporter } from "./cli-command-reporter.js";
import { createInlineProgressRunner } from "./cli-progress-reporter.js";
import { formatInitResult, formatIntegrationChange } from "./cli-output.js";
import { indexRepository, type IndexPipelineResult } from "../../core/indexing/index-pipeline.service.js";
import type { IndexRunOutcome } from "../../core/indexing/indexing.types.js";
import { initializeRepository } from "../../core/repository/repository-init.service.js";
import { getRepositoryStatus } from "../../core/repository/repository-status.service.js";
import type { IntegrationId } from "../../core/integration/integration.types.js";
import { createAgentIntegrationService } from "../../infrastructure/integration/default-integrations.js";
import { installGuidance } from "../../infrastructure/integration/strict-guidance.js";

export type InitCommandDependencies = {
  indexRepository?: (repoPath: string, options: { progress: ReturnType<typeof createCliCommandReporter>["progress"] }) => Promise<IndexRunOutcome>;
};

export async function runInitCommand(
  args: string[],
  repoPath = path.resolve("."),
  dependencies: InitCommandDependencies = {},
): Promise<void> {
  const agent = agentValue(args);
  const optionValues = new Set([agent, "user", "project"]);
  const explicitPath = args.find((arg, index) => {
    if (arg.startsWith("--") || optionValues.has(arg)) return false;
    if (args[index - 1] === "--agent" || args[index - 1] === "--scope") return false;
    return true;
  });
  const targetPath = explicitPath ? path.resolve(repoPath, explicitPath) : repoPath;
  const reporter = createCliCommandReporter({ command: "init", json: args.includes("--json") });
  reporter.start("CodeAtlas Init");
  const result = await reporter.run("Initializing repository", () => initializeRepository(targetPath));
  const json = args.includes("--json");
  const noGuidance = args.includes("--no-guidance");
  const noIndex = args.includes("--no-index");
  let indexResult: IndexPipelineResult | undefined;
  let indexError: string | undefined;

  if (!noIndex) {
    try {
      const outcome = await reporter.run(
        "Indexing repository",
        (progressReporter) => (dependencies.indexRepository ?? indexRepository)(targetPath, {
          progress: createInlineProgressRunner(progressReporter),
        }),
      );
      if (outcome.kind === "failed") {
        indexError = outcome.failure.message;
        process.exitCode = 1;
      } else {
        indexResult = outcome as IndexPipelineResult;
      }
    } catch (error) {
      indexError = error instanceof Error ? error.message : String(error);
      process.exitCode = 1;
    }
  }

  let guidanceChanged = !noGuidance
    ? await installGuidance(targetPath, args.includes("--strict"))
    : false;
  const status = await getRepositoryStatus(targetPath);
  const integrations = [];

  if (indexError) {
    if (json) {
      reporter.output(initOutput(result, status, false, guidanceChanged, undefined, indexError));
    } else {
      reporter.failure(`Indexing failed: ${indexError}`);
      reporter.success(formatInitResult(result, status, false, guidanceChanged));
    }
    return;
  }

  if (agent) {
    const service = createAgentIntegrationService({ cwd: targetPath });
    if (agent !== "all" && !service.has(agent)) {
      throw new Error(`Unknown integration id \`${agent}\`. Registered integrations: ${service.listDescriptors().map(({ id }) => id).join(", ")}.`);
    }
    const ids = agent === "all" ? service.listDescriptors().map(({ id }) => id) : [agent as IntegrationId];
    for (const id of ids) {
      const options = { repoPath: targetPath, strict: args.includes("--strict") };
      const status = await service.status(id, options);
      if (agent === "all" && (status.installation.state !== "installed" || status.connection.state === "invalid_config" || status.connection.state === "stale")) continue;
      integrations.push(await reporter.run(
        `Connecting CodeAtlas to ${id}`,
        () => service.connect(id, { ...options, noGuidance }),
      ));
    }
  }

  if (json) {
    reporter.output(initOutput(result, status, indexResult !== undefined, guidanceChanged, integrations));
    return;
  }
  reporter.success(formatInitResult(result, status, indexResult !== undefined, guidanceChanged, indexResult));
  for (const integration of integrations) reporter.success(`\n${formatIntegrationChange(integration)}`);
}

function initOutput(
  result: Awaited<ReturnType<typeof initializeRepository>>,
  status: Awaited<ReturnType<typeof getRepositoryStatus>>,
  indexed: boolean,
  guidanceChanged: boolean,
  integrations?: unknown,
  error?: string,
): Record<string, unknown> {
  return {
    ...result,
    indexed,
    files: status.repository.sourceFiles,
    symbols: status.graph.nodes,
    relationships: status.graph.edges,
    graph: { status: status.graph.status, indexedFiles: status.graph.indexedFiles, nodes: status.graph.nodes, edges: status.graph.edges },
    lexical: { status: status.capabilities.lexical.state, indexedFiles: status.capabilities.lexical.indexedFiles },
    guidance: { changed: guidanceChanged },
    ...(integrations !== undefined ? { integrations } : {}),
    ...(error !== undefined ? { error } : {}),
  };
}

function agentValue(args: string[]): string | undefined {
  const index = args.indexOf("--agent");
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (!value) throw new Error("An integration id or `all` is required.");
  return value;
}
