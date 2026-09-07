import type { GraphNodeType } from "../graph/types.js";
import type { CoverageDiagnostics } from "../diagnostics/coverage-diagnostics.types.js";

export type InspectChangeInput =
  | { mode?: "working"; maxDepth?: number }
  | { mode: "staged"; maxDepth?: number }
  | { mode: "commit"; commit: string; maxDepth?: number }
  | { mode: "range"; base: string; head: string; maxDepth?: number };

export type InspectChangeSource =
  | { mode: "working" }
  | { mode: "staged" }
  | { mode: "commit"; commit: string }
  | { mode: "range"; base: string; head: string };

export type ChangedHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
};

export type ChangedFile = {
  oldPath?: string;
  path: string;
  status: "added" | "modified" | "deleted" | "renamed" | "binary";
  additions?: number;
  deletions?: number;
  hunks: ChangedHunk[];
};

export type ChangedSymbol = {
  symbolId: string;
  name: string;
  kind: GraphNodeType;
  file: string;
  startLine?: number;
  endLine?: number;
  changeKind: "added" | "modified" | "deleted";
};

export type AffectedSymbol = {
  symbolId: string;
  name: string;
  kind: GraphNodeType;
  file: string;
  startLine?: number;
  endLine?: number;
  originatingSymbols: string[];
  relation: string;
  depth: number;
  path: string[];
  reason: string;
};

export type InspectChangeResult = {
  source: InspectChangeSource;
  summary: {
    changedFiles: number;
    changedSymbols: number;
    affectedSymbols: number;
    affectedFiles: number;
  };
  files: ChangedFile[];
  changedSymbols: ChangedSymbol[];
  affectedSymbols: AffectedSymbol[];
  affectedFiles: string[];
  risk: "low" | "medium" | "high" | "unknown";
  mayBeIncomplete: boolean;
  reasons: string[];
  diagnostics: CoverageDiagnostics;
};
