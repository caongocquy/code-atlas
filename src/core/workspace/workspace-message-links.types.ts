import type { WorkspaceMapInput, WorkspaceMember } from "./workspace.types.js";
import type { RepositoryMessageConsumerEntry } from "../graph/intelligence/repository-entry-catalog.types.js";
import type { MessageProducerCall } from "../graph/intelligence/message-producer-evidence.types.js";
import type { GraphNode } from "../graph/types.js";

export type WorkspaceMessageLinksInput = WorkspaceMapInput & {
  sourceRepositoryId?: string; targetRepositoryId?: string;
  producerSymbol?: string; consumerId?: string;
  protocolKind?: "unspecified" | "kafka"; destination?: string;
};
export type WorkspaceMessageDiagnostic = {
  repositoryId: string; generationId?: string; role: "member" | "producer" | "consumer"; code: string; ref?: { file?: string; id?: string };
};
export type WorkspaceRoleCoverage = {
  status: "supported" | "unsupported" | "unavailable" | "not_requested";
  scanComplete: boolean; knownInspected: number; reasons: string[];
};
export type WorkspaceMessageMember = WorkspaceMember & {
  producerCoverage: WorkspaceRoleCoverage; consumerCoverage: WorkspaceRoleCoverage; diagnostics: WorkspaceMessageDiagnostic[];
};
export type WorkspaceMessagingInputs = {
  producers: MessageProducerCall[]; consumers: RepositoryMessageConsumerEntry[];
  callables: GraphNode[]; producerCoverage: WorkspaceRoleCoverage; consumerCoverage: WorkspaceRoleCoverage;
  diagnostics: WorkspaceMessageDiagnostic[];
};
export type WorkspaceProducerSource = {
  repositoryId: string; generationId: string;
  producerCallRef: MessageProducerCall["callRef"];
  sourceCallableRef: { id: string; file: string; name: string; qualifiedName?: string };
};
export type WorkspaceConsumerTarget = {
  repositoryId: string; generationId: string; path: string; consumerId: string;
  bindingSummary: { subjectId: string; bindingKind: "callable"; callableKey: RepositoryMessageConsumerEntry["callableKey"] };
};
export type WorkspaceMessageProvenance = {
  sourceProducerEvidence: { repositoryId: string; generationId: string; ref: MessageProducerCall["callRef"]; proof?: MessageProducerCall["provenance"] };
  targetConsumerEvidence: { repositoryId: string; generationId: string; consumerId: string; refs: RepositoryMessageConsumerEntry["provenance"]["refs"]; proof?: RepositoryMessageConsumerEntry["provenance"] };
};
export type WorkspaceMessageLink = {
  source: WorkspaceProducerSource;
  destination: MessageProducerCall["destination"] & { producerKind: MessageProducerCall["producerKind"] };
  target: WorkspaceConsumerTarget;
  compatibility: { status: "compatible"; reason: string; scope: "workspace_cross_repo" };
  provenance: WorkspaceMessageProvenance;
  runtimeLimitation: string;
};
export type WorkspaceProducerRecord = {
  source: WorkspaceProducerSource;
  destination: WorkspaceMessageLink["destination"];
  apiKind: MessageProducerCall["apiKind"];
  cardinality: "none" | "one" | "many" | "unknown";
  provenance: WorkspaceMessageProvenance["sourceProducerEvidence"];
};
