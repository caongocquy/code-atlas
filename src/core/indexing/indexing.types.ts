import type { ProgressRunner } from "../progress/progress.types.js";
import type { EmbeddingProvider } from "../semantic/embedding-provider.js";
import type { VectorStore } from "../semantic/vector-store.js";
import type { ParsedFactsBlob } from "../facts/facts.types.js";
import type { CodeChunk } from "../graph/parsers/types.js";

export type IndexedSourceUnit = {
  relativePath: string;
  source: string;
  facts: ParsedFactsBlob;
};

export function codeChunksFromFacts(unit: IndexedSourceUnit): CodeChunk[] {
  const lines = unit.source.split("\n");

  return unit.facts.symbols.map((symbol) => ({
    symbolName: symbol.name,
    symbolType: symbol.kind,
    language: unit.facts.language,
    content: lines.slice(symbol.range.startLine - 1, symbol.range.endLine).join("\n"),
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
};

export type IndexPipelineOptions = {
  progress?: ProgressRunner;
  skipGit?: boolean;
  includeSemantic?: boolean;
  semanticProviders?: {
    embeddingProvider: EmbeddingProvider;
    vectorStore: VectorStore;
  };
};
