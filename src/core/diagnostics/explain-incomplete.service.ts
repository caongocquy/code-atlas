import { affectedTests } from "../change/affected-tests.service.js";
import { inspectChange } from "../change/inspect-change.service.js";
import type { InspectChangeInput } from "../change/change.types.js";
import {
  repositoryCoverageDiagnostics,
} from "./coverage-diagnostics.service.js";
import type { CoverageDiagnostics } from "./coverage-diagnostics.types.js";

export type ExplainIncompleteInput = {
  scope?: "repository" | "change" | "tests";
  mode?: InspectChangeInput["mode"];
  commit?: string;
  base?: string;
  head?: string;
  maxDepth?: number;
};

export type ExplainIncompleteResult = CoverageDiagnostics & {
  scope: "repository" | "change" | "tests";
  source?: Awaited<ReturnType<typeof inspectChange>>["source"];
};

function sourceInput(input: ExplainIncompleteInput): InspectChangeInput {
  const mode = input.mode ?? "working";
  if (mode === "commit") {
    if (!input.commit) throw new Error("commit is required for commit mode");
    return { mode, commit: input.commit, maxDepth: input.maxDepth };
  }
  if (mode === "range") {
    if (!input.base || !input.head) throw new Error("base and head are required for range mode");
    return { mode, base: input.base, head: input.head, maxDepth: input.maxDepth };
  }
  if (input.commit || input.base || input.head) throw new Error("revision fields do not match the selected change mode");
  return { mode, maxDepth: input.maxDepth };
}

export async function explainIncomplete(
  repoPath: string,
  input: ExplainIncompleteInput = {},
): Promise<ExplainIncompleteResult> {
  const scope = input.scope ?? "repository";
  if (scope === "repository") {
    if (input.mode || input.commit || input.base || input.head || input.maxDepth !== undefined) {
      throw new Error("change source options require --change or --tests");
    }
    return { scope, ...(await repositoryCoverageDiagnostics(repoPath)) };
  }

  const source = sourceInput(input);
  if (scope === "change") {
    const result = await inspectChange(repoPath, source);
    return { scope, source: result.source, ...result.diagnostics };
  }

  const result = await affectedTests(repoPath, source);
  return { scope, source: result.source, ...result.diagnostics };
}
