import type { GraphEdge, GraphNode } from "../../core/graph/types.js";
import type { RepositoryIdentity } from "../../core/repository/repository-identity.js";

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
};

export type GraphFileState = {
  fileHash: string;
};

export type GraphFileUpdate = {
  file: string;
  fileHash: string;
  nodes: GraphNode[];
  edges: GraphEdge[];
};

export type IndexMetadata = {
  version: string;
  updatedAt: string;
};
