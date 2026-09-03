import type { ProgressRunner } from "../progress/progress.types.js";

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
};
