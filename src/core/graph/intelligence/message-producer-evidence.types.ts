import type { FactBlobKey, MaterializedFileFacts, SourceRangeFact } from "../../facts/facts.types.js";
import type { GraphNode } from "../types.js";

export type MessageProducerApiKind = "client_proxy_send" | "client_proxy_emit" | "kafka_template_send";
export type MessageProducerKind = "request" | "event";

export type MessageProducerDestination =
  | { protocolKind: "unspecified"; destinationKind: "pattern"; value: string; transport: "unknown" }
  | { protocolKind: "kafka"; destinationKind: "topic"; value: string };

export type MessageProducerCall = {
  sourceCallable: GraphNode;
  callRef: {
    generationId: string;
    file: string;
    factBlobKey?: FactBlobKey;
    callId: string;
    syntaxId: string;
    range: SourceRangeFact;
  };
  apiKind: MessageProducerApiKind;
  producerKind: MessageProducerKind;
  receiverProof: "exact";
  wholeArgumentProof: "exact";
  destination: MessageProducerDestination;
  provenance: {
    receiverDeclarationId: string;
    typeAnnotationId: string;
    importId?: string;
    receiverSyntaxId: string;
    literalSyntaxId: string;
  };
  mayBeIncomplete: boolean;
  reasons: string[];
};

export type MessageProducerDiagnostic = {
  file: string;
  code: string;
  receiverProof?: "exact" | "ambiguous" | "unknown";
  callId?: string;
  range?: SourceRangeFact;
};

export type DetectMessageProducersResult = {
  producers: MessageProducerCall[];
  diagnostics: MessageProducerDiagnostic[];
};

export type MessageProducerFacts = MaterializedFileFacts[];
