import type { ProgressRunner } from "../progress/progress.types.js";
import type { EmbeddingProvider } from "../semantic/embedding-provider.js";
import type { VectorStore } from "../semantic/vector-store.js";
import type { ParsedFactsBlob } from "../facts/facts.types.js";
import type { CodeChunk } from "../graph/parsers/types.js";
import type { CodeGraph } from "../graph/types.js";
import type { InvalidationPlan } from "./invalidation-planner.js";
import type { IndexWorkCounters } from "./index-work-counters.js";
import type { ScipIndexer } from "./scip-indexer.types.js";

export type InvalidationReasonCode =
  | "source_changed"
  | "direct_importer"
  | "resolution_version_changed"
  | "unresolved_import_ownership"
  | "path_moved"
  | "path_renamed"
  | "module_config_changed"
  | "export_ambiguous"
  | "dependency_provenance_incomplete"
  | "scip_fingerprint_changed"
  | "scip_status_changed"
  | "facts_version_changed";

export type ResolutionScopeReason =
  | "changed_source"
  | "direct_importer"
  | "resolution_version"
  | "uncertain_importer"
  | "module_move"
  | "module_rename"
  | "module_config"
  | "export_ambiguity"
  | "incomplete_provenance"
  | "facts_change";

export type ResolutionScope = {
  mode: "bounded" | "repository";
  paths: readonly string[];
  reasons: readonly ResolutionScopeReason[];
};

export type IndexedSourceUnit = {
  relativePath: string;
  source: string;
  facts: ParsedFactsBlob;
};

export type CandidateResolutionInput = {
  allUnits: readonly IndexedSourceUnit[];
  scope: ResolutionScope;
  previousGenerationId?: string;
  previousGraph?: CodeGraph;
};

export function codeChunksFromFacts(unit: IndexedSourceUnit): CodeChunk[] {
  const lines = unit.source.split("\n");

  function sourceSlice(startLine: number, endLine: number, startColumn?: number, endColumn?: number): string {
    const selected = lines.slice(startLine - 1, endLine);
    if (selected.length === 0) return "";
    if (selected.length === 1) return selected[0]?.slice(startColumn ?? 0, endColumn) ?? "";
    const first = selected[0]?.slice(startColumn ?? 0) ?? "";
    const last = selected.at(-1)?.slice(0, endColumn) ?? "";
    return [first, ...selected.slice(1, -1), last].join("\n");
  }

  return unit.facts.symbols.map((symbol) => ({
    symbolName: symbol.name,
    symbolType: symbol.kind,
    language: unit.facts.language,
    content: sourceSlice(symbol.range.startLine, symbol.range.endLine, symbol.range.startColumn, symbol.range.endColumn),
    startLine: symbol.range.startLine,
    endLine: symbol.range.endLine,
    startColumn: symbol.range.startColumn,
    endColumn: symbol.range.endColumn,
  }));
}

export type ChangeDetectionMode = "git" | "filesystem";

export type IndexCapability = "graph" | "lexical" | "semantic";

export type IndexingChanges = {
  changeDetection: ChangeDetectionMode;
  files: string[];
  relativeFiles: string[];
  candidateFiles: string[];
  fileHashes: Map<string, string>;
  addedFiles: string[];
  changedFiles: string[];
  deletedFiles: string[];
  moduleConfigChanged?: boolean;
};

export type IndexPipelineOptions = {
  progress?: ProgressRunner;
  skipGit?: boolean;
  includeSemantic?: boolean;
  semanticProviders?: {
    embeddingProvider: EmbeddingProvider;
    vectorStore: VectorStore;
  };
  scipIndexer?: ScipIndexer;
};

export type IndexFailure = {
  kind: "infrastructure_failure" | "cache_write_failure" | "source_race";
  message: string;
  activeGenerationId?: string;
};

export type PublishedIndexRun = {
  kind: "published";
  repositoryId: string;
  generationId: string;
  plan: InvalidationPlan;
  published: true;
  counters: Readonly<IndexWorkCounters>;
};

export type FailedIndexRun = {
  kind: "failed";
  repositoryId: string;
  activeGenerationId?: string;
  published: false;
  failure: IndexFailure;
};

export type IndexRunOutcome = PublishedIndexRun | FailedIndexRun;
