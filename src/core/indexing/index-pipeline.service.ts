import path from "node:path";

import { GRAPH_INDEX_VERSION, LEXICAL_INDEX_VERSION, VECTOR_INDEX_VERSION } from "../../config/constants.js";
import { AtlasStore } from "../../storage/atlas/atlas.store.js";
import { getRepositoryIdentity, canonicalRepositoryPath } from "../repository/repository-identity.js";
import { indexGraph, type GraphIndexResult } from "../graph/graph-index.service.js";
import { indexLexical, type LexicalIndexResult } from "../lexical/lexical-index.service.js";
import { syncSemantic, type SemanticIndexResult } from "../semantic/semantic-index.service.js";
import { detectRepositoryChanges } from "./change-detector.js";
import type { IndexPipelineOptions, IndexingChanges } from "./indexing.types.js";

export type IndexPipelineResult = {
  repoPath: string;
  repoId: string;
  operation: "index" | "sync";
  changeDetection: "git" | "filesystem";
  changes: Pick<IndexingChanges, "addedFiles" | "changedFiles" | "deletedFiles" | "candidateFiles">;
  graph: GraphIndexResult;
  lexical: LexicalIndexResult;
  semantic?: SemanticIndexResult;
};

async function runPipeline(
  inputPath: string,
  operation: IndexPipelineResult["operation"],
  options: IndexPipelineOptions,
): Promise<IndexPipelineResult> {
  const repoPath = canonicalRepositoryPath(path.resolve(inputPath));
  const progress = options.progress;
  const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
  const repoId = store.ensureRepository(getRepositoryIdentity(repoPath)).id;
  const capabilities = options.includeSemantic
    ? ["graph", "lexical", "semantic"] as const
    : ["graph", "lexical"] as const;

  let changes: IndexingChanges;

  try {
    changes = await detectRepositoryChanges(repoPath, {
      store,
      repoId,
      capabilities: [...capabilities],
      versions: {
        graph: GRAPH_INDEX_VERSION,
        lexical: LEXICAL_INDEX_VERSION,
        semantic: VECTOR_INDEX_VERSION,
      },
      skipGit: options.skipGit,
      progress,
      forceFullScan: operation === "index",
    });
  } finally {
    store.close();
  }

  const serviceOptions = {
    progress,
    files: changes.files,
    candidateFiles: changes.candidateFiles,
    deletedFiles: changes.deletedFiles,
    fileHashes: changes.fileHashes,
    forceFullRebuild: operation === "index",
    forceFullReindex: operation === "index",
  };
  const graph = await indexGraph(repoPath, serviceOptions);
  const lexical = await indexLexical(repoPath, serviceOptions);
  const semantic = options.includeSemantic
    ? await syncSemantic(repoPath, serviceOptions)
    : undefined;

  return {
    repoPath,
    repoId,
    operation,
    changeDetection: changes.changeDetection,
    changes: {
      addedFiles: changes.addedFiles,
      changedFiles: changes.changedFiles,
      deletedFiles: changes.deletedFiles,
      candidateFiles: changes.candidateFiles,
    },
    graph,
    lexical,
    semantic,
  };
}

export function indexRepository(
  repoPath: string,
  options: IndexPipelineOptions = {},
): Promise<IndexPipelineResult> {
  return runPipeline(repoPath, "index", options);
}

export function syncRepository(
  repoPath: string,
  options: IndexPipelineOptions = {},
): Promise<IndexPipelineResult> {
  return runPipeline(repoPath, "sync", options);
}
