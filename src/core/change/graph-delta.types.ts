import type { CoverageDiagnostics } from "../diagnostics/coverage-diagnostics.types.js";
import type { SymbolReference } from "./test-intelligence.types.js";
import type { ChangedFile, InspectChangeInput, InspectChangeSource } from "./change.types.js";

export type FileReference = { file: string };

export type StructuralSymbolReference = SymbolReference & {
  qualifiedName?: string;
};

export type StructuralReference = FileReference | StructuralSymbolReference;

export type StructuralEdge = {
  from: StructuralReference;
  to: StructuralReference;
  kind: "imports" | "calls";
  resolution?: {
    strategy?: string;
    confidence?: "high" | "medium" | "low";
  };
  evidence: {
    source: "transient_source_analysis";
    resolutionStrategy?: string;
  };
};

export type GraphDeltaInput = InspectChangeInput & { maxEdges?: number };

export type GraphDeltaResult = {
  source: InspectChangeSource;
  summary: {
    changedFiles: number;
    addedEdges: number;
    removedEdges: number;
    unchangedRelevantEdges: number;
  };
  changedFiles: ChangedFile[];
  addedEdges: StructuralEdge[];
  removedEdges: StructuralEdge[];
  diagnostics: CoverageDiagnostics;
  mayBeIncomplete: boolean;
  reasons: string[];
};
