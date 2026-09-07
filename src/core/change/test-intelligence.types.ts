import type { GraphNodeType } from "../graph/types.js";
import type { InspectChangeInput, InspectChangeSource } from "./change.types.js";
import type { CoverageDiagnostics } from "../diagnostics/coverage-diagnostics.types.js";

export type SymbolReference = {
  symbolId: string;
  name: string;
  kind: GraphNodeType;
  file: string;
  startLine?: number;
  endLine?: number;
};

export type TestEvidence =
  | { kind: "direct_reference"; affectedSymbolId: string }
  | { kind: "call_path"; affectedSymbolId: string; path: string[] }
  | { kind: "import_dependency"; affectedFile: string };

export type AffectedTest = {
  file: string;
  testSymbols?: SymbolReference[];
  reasons: TestEvidence[];
  distance?: number;
  confidence: "high" | "medium" | "low";
};

export type AffectedTestsInput = InspectChangeInput & { maxTests?: number };

export type UncoveredAffectedSymbol = SymbolReference & {
  reason: "no_structural_test_evidence";
};

export type AffectedTestsResult = {
  source: InspectChangeSource;
  change: {
    changedFiles: number;
    changedSymbols: number;
    affectedSymbols: number;
  };
  summary: {
    testsToRun: number;
    changedTests: number;
    affectedProductionSymbols: number;
    symbolsWithTestEvidence: number;
    uncoveredAffectedSymbols: number;
  };
  tests: AffectedTest[];
  changedTests: string[];
  uncoveredAffectedSymbols: UncoveredAffectedSymbol[];
  uncoveredAffectedFiles: string[];
  mayBeIncomplete: boolean;
  reasons: string[];
  diagnostics: CoverageDiagnostics;
};
