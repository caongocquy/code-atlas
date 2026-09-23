import type { GraphEdge, GraphNode } from "../../core/graph/types.js";
import type { GraphResolutionFile, ResolutionCoverage } from "../../core/graph/resolution.types.js";
import type { RepositoryIdentity } from "../../core/repository/repository-identity.js";
import type {
  FactBlobKey,
  FileFactBinding,
  ParsedFactsBlob,
} from "../../core/facts/facts.types.js";
import type { IndexGeneration, IndexManifest } from "../../core/indexing/index-manifest.js";
import type { FrameworkSnapshot } from "../../core/framework/framework.types.js";
import type { ReliabilityContribution } from "../../core/reliability/reliability.types.js";

export type AtlasIndexAxis =
  | "schema"
  | "parser"
  | "graph"
  | "lexical"
  | "semantic"
  | "metrics";

export type AtlasCapability = "graph" | "lexical" | "semantic" | "reranker" | "metrics";

export type CapabilityState =
  | "ready"
  | "disabled"
  | "not_configured"
  | "not_indexed"
  | "unavailable"
  | "error"
  | "stale";

export type AtlasRepository = RepositoryIdentity & {
  createdAt: string;
  updatedAt: string;
};

export type AtlasFileCapabilityState = {
  repositoryId: string;
  file: string;
  fileHash?: string;
  capability: AtlasCapability;
  version: string;
  state: CapabilityState;
  generation?: string;
  providerIdentity?: string;
  itemCount: number;
  lastError?: string;
  updatedAt: string;
};

export type FileCapabilityStateInput = {
  version: string;
  state: CapabilityState;
  generation?: string;
  providerIdentity?: string;
  itemCount: number;
  fileHash?: string;
  lastError?: string;
};

export type LexicalDocument = {
  documentId: string;
  file: string;
  symbolName?: string;
  qualifiedName?: string;
  symbolType?: string;
  content: string;
  startLine?: number;
  endLine?: number;
};

export type LexicalFileUpdate = {
  file: string;
  fileHash: string;
  documents: LexicalDocument[];
};

export type LexicalSearchRow = LexicalDocument & {
  score: number;
  snippet: string;
  lexicalRankGroup?: string;
};

export type GraphFileState = {
  fileHash: string;
};

export type GraphFileUpdate = {
  file: string;
  fileHash: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
  resolution?: GraphResolutionFile;
};

export type AtlasEdgeResolutionColumns = {
  resolution_strategy: string | null;
  resolution_confidence: "exact" | "strong" | null;
  resolution_evidence_json: string | null;
  resolution_version: string | null;
  resolution_source_identity: string | null;
  resolution_target_identity: string | null;
};

export type GraphResolutionCoverage = ResolutionCoverage & {
  resolvedExtends: number;
  unresolvedExtends: number;
  ambiguousExtends: number;
};

export type IndexMetadata = {
  version: string;
  updatedAt: string;
};

export type AtlasFactBlob = {
  factBlobKey: FactBlobKey;
  facts: ParsedFactsBlob;
};

export type AtlasFactBlobRow = {
  fact_blob_key: FactBlobKey;
  content_hash: string;
  language: ParsedFactsBlob["language"];
  parser_identity_json: string;
  facts_version: string;
  facts_schema_version: string;
  payload_json: string;
};

export type AtlasFileFactBinding = FileFactBinding;
export type AtlasIndexGeneration = IndexGeneration;
export type AtlasIndexManifest = IndexManifest;

export type FrameworkQueryInputs = {
  graph: import("../../core/graph/types.js").CodeGraph;
  framework: FrameworkSnapshot | undefined;
  reliability: readonly ReliabilityContribution[];
};
