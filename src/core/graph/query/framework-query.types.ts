import type {
  FrameworkClassification,
  FrameworkCoverage,
  FrameworkDiagnostic,
  FrameworkEntity,
  FrameworkRelationship,
} from "../../framework/framework.types.js";
import type { GraphEdge, GraphNode } from "../types.js";

export type FrameworkQueryNode =
  | { kind: "language"; node: GraphNode }
  | { kind: "framework"; entity: FrameworkEntity };

export type FrameworkQueryEdge =
  | { kind: "language"; edge: GraphEdge }
  | { kind: "framework"; relationship: FrameworkRelationship };

export interface FrameworkQueryProjection {
  nodes: readonly FrameworkQueryNode[];
  edges: readonly FrameworkQueryEdge[];
  classifications: readonly FrameworkClassification[];
  diagnostics: readonly FrameworkDiagnostic[];
  coverage: readonly FrameworkCoverage[];
  mayBeIncomplete: boolean;
}
