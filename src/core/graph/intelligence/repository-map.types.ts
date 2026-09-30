import type { FrameworkDiagnostic, FrameworkCoverage, FrameworkId } from "../../framework/framework.types.js";
import type { ReliabilityProjection } from "../../reliability/reliability.types.js";
import type { GraphEdge, GraphEdgeType, GraphNode } from "../types.js";

export type RepositoryMapBoundarySource = "architecture_group" | "structural_community";
export type RepositoryMapIdentityStability = "configuration_stable" | "graph_generation_member_set";

export interface RepositoryMapArea {
  id: string;
  label: string;
  boundarySource: RepositoryMapBoundarySource;
  identityStability: RepositoryMapIdentityStability;
  identitySemantics: string;
  fileCount: number;
  symbolCount: number;
  memberIds: string[];
  files: string[];
  directories: string[];
  representativeSymbols: GraphNode[];
  internalEdgeCount: number;
  externalEdgeCount: number;
  cohesion: number;
  coupling: number;
  frameworkIds: FrameworkId[];
  executionEntryBindingCount: number;
}

export interface RepositoryMapRelation {
  sourceAreaId: string;
  targetAreaId: string;
  edgeCount: number;
  relationCounts: Partial<Record<GraphEdgeType, number>>;
  representativeEdges: GraphEdge[];
}

export interface RepositoryMapFileDiagnostic {
  count: number;
  paths: string[];
}

export interface RepositoryMapDiagnostics {
  ambiguousFiles: RepositoryMapFileDiagnostic;
  unclassifiedFiles: RepositoryMapFileDiagnostic;
  unmappedArchitecturalEdges: {
    count: number;
    ambiguousEndpointCount: number;
    unclassifiedEndpointCount: number;
    missingEndpointCount: number;
  };
  incompleteEvidence: {
    graph: boolean;
    framework: boolean;
    structuralCommunitiesTruncated: boolean;
  };
  truncation: {
    diagnosticPaths: boolean;
    areas: boolean;
    files: boolean;
    relations: boolean;
    representativeEdges: boolean;
    frameworkDiagnostics: boolean;
  };
  frameworkDiagnostics: readonly FrameworkDiagnostic[];
  frameworkCoverage: readonly FrameworkCoverage[];
}

export interface RepositoryMapCoverage {
  graphMayBeIncomplete: boolean;
  frameworkMayBeIncomplete: boolean;
  classificationMayBeIncomplete: boolean;
  mayBeIncomplete: boolean;
}

export interface RepositoryMap {
  boundarySource: RepositoryMapBoundarySource;
  identityStability: RepositoryMapIdentityStability;
  areas: RepositoryMapArea[];
  relations: RepositoryMapRelation[];
  diagnostics: RepositoryMapDiagnostics;
  coverage: RepositoryMapCoverage;
  mayBeIncomplete: boolean;
  frameworkReliability?: ReliabilityProjection;
}

export interface RepositoryMapOptions {
  graphMayBeIncomplete?: boolean;
  maxDiagnosticPaths?: number;
}
