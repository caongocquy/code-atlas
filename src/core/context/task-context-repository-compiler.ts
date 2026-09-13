import path from "node:path";

import { affectedTests } from "../change/affected-tests.service.js";
import { inspectChange } from "../change/inspect-change.service.js";
import { loadIndexedGraphReadOnly } from "../graph/indexed-graph.service.js";
import { analyzeImpact } from "../graph/query/impact.service.js";
import { searchLexical } from "../lexical/lexical-search.service.js";
import { getRepositoryStatus } from "../repository/repository-status.service.js";
import { inspectHybridSearch } from "../retrieval/hybrid-search.service.js";
import { canonicalRepositoryPath, getRepositoryIdentity } from "../repository/repository-identity.js";
import { getWorkspaceIdentity } from "./context-identity.js";
import { collectTaskContextCandidates, enrichTaskContextCandidates, enrichTaskContextGraph } from "./task-context-candidates.js";
import { compileTaskContext } from "./task-context-compiler.js";
import type { CompileTaskContextInput, NormalizedTaskContextInput, TaskContextCandidate, TaskContextPlanDetail, TaskContextReliability } from "./task-context.types.js";

export type RepositoryCompilerDeps = {
  compile?: typeof compileTaskContext;
  loadGraph?: typeof loadIndexedGraphReadOnly;
  collect?: (normalized: NormalizedTaskContextInput) => Promise<{ candidates: TaskContextCandidate[]; reliability: TaskContextReliability }>;
};

export class TaskContextRepositoryCompilerError extends Error {
  constructor(readonly code: "index_required", message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "TaskContextRepositoryCompilerError";
  }
}

export async function compileTaskContextForRepository(repoPath: string, input: CompileTaskContextInput, deps: RepositoryCompilerDeps = {}): Promise<TaskContextPlanDetail> {
  const root = canonicalRepositoryPath(path.resolve(repoPath));
  const workspace = getWorkspaceIdentity(root);
  const repository = getRepositoryIdentity(root);
  const compiler = deps.compile ?? compileTaskContext;
  if (deps.collect) return compiler(input, { repositoryPath: root, repositoryIdentity: repository.identityKey, workspaceIdentity: workspace.workspaceIdentity, collect: deps.collect });
  let indexed;
  try {
    indexed = await (deps.loadGraph ?? loadIndexedGraphReadOnly)(root);
  } catch (error) {
    if (error instanceof Error && error.message === "Repository graph is not indexed.") {
      throw new TaskContextRepositoryCompilerError("index_required", error.message, { cause: error });
    }
    throw error;
  }
  const collectionDeps = {
    repositoryPath: root,
    loadGraph: async () => indexed,
    getStatus: getRepositoryStatus,
    lexicalSearch: searchLexical,
    hybridSearch: inspectHybridSearch,
    inspectChange,
    analyzeImpact: async (...args: Parameters<typeof analyzeImpact>) => analyzeImpact(...args),
    affectedTests,
  };
  return compiler(input, {
    repositoryPath: root,
    repositoryIdentity: repository.identityKey,
    workspaceIdentity: workspace.workspaceIdentity,
    collect: async (normalized) => {
      const collected = await collectTaskContextCandidates(normalized, collectionDeps);
      const enriched = await enrichTaskContextCandidates(collected.candidates, normalized, indexed.graph, collectionDeps);
      return {
        candidates: enrichTaskContextGraph(enriched.candidates, indexed.graph),
        reliability: {
          ...collected.reliability,
          mayBeIncomplete: collected.reliability.mayBeIncomplete || enriched.reliability.mayBeIncomplete,
          diagnostics: [...collected.reliability.diagnostics, ...enriched.reliability.diagnostics],
        },
      };
    },
  });
}
