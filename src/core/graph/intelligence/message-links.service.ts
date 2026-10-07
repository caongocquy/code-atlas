import type { IndexedMessageGraph } from "../indexed-graph.service.js";
import { loadIndexedMessageGraphReadOnly } from "../indexed-graph.service.js";
import { resolveGraphEntity } from "../query/graph-query-entity-resolver.js";
import { exactProjectionCount } from "../../projection/known-collection.js";
import { buildRepositoryEntryCatalog } from "./repository-entry-catalog.service.js";
import type { RepositoryEntry } from "./repository-entry-catalog.types.js";
import { detectMessageProducers } from "./message-producer-evidence.js";
import type { MessageProducerCall } from "./message-producer-evidence.types.js";

export type MessageLinksInput = {
  producerSymbol?: string;
  consumerId?: string;
  protocolKind?: "unspecified" | "kafka";
  destination?: string;
  limit?: number;
  detail?: "compact" | "full";
};

type Consumer = Extract<RepositoryEntry, { kind: "message_consumer" }>;
export type MessageCompatibility = "compatible" | "incompatible" | "unresolved";
export const MESSAGE_RUNTIME_LIMITATION = "Statically compatible declared mapping only; runtime dispatch, delivery, transport, broker and environment are unverified.";

export class MessageLinksError extends Error {
  constructor(readonly code: "invalid_arguments" | "not_found" | "ambiguous", message: string) { super(message); }
}

export function messageCompatibility(producer: MessageProducerCall, consumer: Consumer): MessageCompatibility {
  if (producer.receiverProof !== "exact" || producer.wholeArgumentProof !== "exact") return "unresolved";
  const d = producer.destination;
  if (d.protocolKind !== consumer.protocolKind || d.destinationKind !== consumer.destinationKind || d.value !== consumer.destination) return "incompatible";
  if (d.protocolKind === "unspecified") return consumer.framework === "nestjs"
    && consumer.consumerKind === (producer.producerKind === "request" ? "request_response" : "event") ? "compatible" : "incompatible";
  return consumer.framework === "spring" && consumer.consumerKind === "event" ? "compatible" : "incompatible";
}

function consumerKey(protocol: string, kind: string, destination: string, consumerKind: string): string {
  return JSON.stringify([protocol, kind, destination, consumerKind]);
}

export function buildMessageLinks(context: IndexedMessageGraph, input: MessageLinksInput = {}) {
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new MessageLinksError("invalid_arguments", "limit must be an integer from 1 to 1000.");
  if (input.producerSymbol !== undefined && input.consumerId !== undefined) throw new MessageLinksError("invalid_arguments", "producerSymbol and consumerId are mutually exclusive.");
  if (input.protocolKind !== undefined && !["unspecified", "kafka"].includes(input.protocolKind)) throw new MessageLinksError("invalid_arguments", "Unsupported producer protocol.");
  if (input.detail !== undefined && !["compact", "full"].includes(input.detail)) throw new MessageLinksError("invalid_arguments", "Unsupported detail.");
  let sourceId: string | undefined;
  if (input.producerSymbol !== undefined) {
    const byId = context.graph.nodes.find(n => n.id === input.producerSymbol);
    const selected = byId ? { status: "resolved" as const, entity: byId } : resolveGraphEntity(context.graph, input.producerSymbol);
    if (selected.status !== "resolved") throw new MessageLinksError(selected.status, "Producer symbol must resolve uniquely to a callable.");
    if (!["function", "method"].includes(selected.entity.type)) throw new MessageLinksError("invalid_arguments", "Producer symbol must be a callable.");
    // Entity resolution offers fuzzy discovery; producer selection requires exact identity/name.
    if (!byId && ![selected.entity.name, selected.entity.qualifiedName, `${selected.entity.file}:${selected.entity.name}`, `${selected.entity.file}:${selected.entity.qualifiedName}`].includes(input.producerSymbol)) throw new MessageLinksError("not_found", "Producer symbol requires an exact callable selector.");
    sourceId = selected.entity.id;
  }
  const catalog = buildRepositoryEntryCatalog(context.framework);
  let consumers = catalog.entries.filter((e): e is Consumer => e.kind === "message_consumer");
  if (input.consumerId !== undefined) {
    consumers = consumers.filter(e => e.id === input.consumerId);
    if (consumers.length !== 1) throw new MessageLinksError("not_found", "Consumer ID must identify an existing message_consumer.");
  }
  const buckets = new Map<string, Consumer[]>();
  for (const c of consumers) {
    const key = consumerKey(c.protocolKind, c.destinationKind, c.destination, c.consumerKind);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(c); else buckets.set(key, [c]);
  }
  for (const bucket of buckets.values()) bucket.sort((a, b) => a.id.localeCompare(b.id));
  const detection = context.evidenceState.generationId
    ? detectMessageProducers(context.sourceFacts, context.graph, context.evidenceState.generationId)
    : { producers: [], diagnostics: [] };
  let producers = detection.producers.filter(p => (sourceId === undefined || p.sourceCallable.id === sourceId)
    && (input.protocolKind === undefined || p.destination.protocolKind === input.protocolKind)
    && (input.destination === undefined || p.destination.value === input.destination));
  const candidates = (p: MessageProducerCall) => buckets.get(consumerKey(p.destination.protocolKind, p.destination.destinationKind,
    p.destination.value, p.destination.protocolKind === "kafka" || p.producerKind === "event" ? "event" : "request_response")) ?? [];
  if (input.consumerId !== undefined) producers = producers.filter(p => candidates(p).length > 0);
  producers.sort((a,b) => a.sourceCallable.file.localeCompare(b.sourceCallable.file)
    || (a.sourceCallable.qualifiedName ?? a.sourceCallable.name).localeCompare(b.sourceCallable.qualifiedName ?? b.sourceCallable.name)
    || a.callRef.range.startLine-b.callRef.range.startLine || (a.callRef.range.startColumn ?? 0)-(b.callRef.range.startColumn ?? 0)
    || a.apiKind.localeCompare(b.apiKind) || a.destination.value.localeCompare(b.destination.value) || a.callRef.syntaxId.localeCompare(b.callRef.syntaxId));
  const linkTotal = producers.reduce((n,p) => n + candidates(p).length, 0);
  const unlinkedTotal = producers.filter(p => candidates(p).length === 0).length;
  const scanComplete = !!context.evidenceState.generationId && context.factDiagnostics.length === 0;
  const allDiagnostics = [...context.factDiagnostics, ...detection.diagnostics];
  const reasons = [...new Set([...context.evidenceState.reasons, ...allDiagnostics.map(d => d.code),
    ...producers.flatMap(p => p.reasons), ...(!scanComplete ? ["producer_scan_incomplete"] : [])])].sort();
  const producerCalls: Array<Omit<MessageProducerCall, "provenance"> & { provenance?: MessageProducerCall["provenance"]; cardinality: "none" | "one" | "many" }> = [];
  const links: Array<{producerCallRef: MessageProducerCall["callRef"]; consumerId: string; compatibility: "compatible"; reason: string;
    runtimeLimitation: string; provenance?: { producer: MessageProducerCall["provenance"]; consumer: Consumer["provenance"] }}> = [];
  const unlinkedProducerCalls: MessageProducerCall["callRef"][] = [];
  let budget = limit;
  // One budget covers all returned records, including diagnostics and unlinked references.
  for (const p of producers) {
    if (budget === 0) break;
    const matches = candidates(p);
    const { provenance, ...compact } = p;
    producerCalls.push({ ...compact, ...(input.detail === "full" ? { provenance } : {}), cardinality: matches.length === 0 ? "none" : matches.length === 1 ? "one" : "many" });
    budget--;
    if (matches.length === 0 && budget > 0) { unlinkedProducerCalls.push(p.callRef); budget--; }
    for (const c of matches) {
      if (budget === 0) break;
      links.push({producerCallRef:p.callRef,consumerId:c.id,compatibility:"compatible",reason:p.destination.protocolKind === "kafka" ? "equal_declared_kafka_topic" : "equal_nest_pattern_and_message_kind",
        runtimeLimitation:MESSAGE_RUNTIME_LIMITATION,...(input.detail === "full" ? { provenance:{producer:provenance,consumer:c.provenance} } : {})});
      budget--;
    }
  }
  const diagnostics = allDiagnostics.slice(0,budget).map(d => input.detail === "full" ? d : {code:d.code,file:d.file});
  const count = (known: number, returned: number) => scanComplete ? exactProjectionCount(known,returned)
    : {total:null,returned,omitted:null,truncated:known>returned,knownInspected:exactProjectionCount(known,returned)};
  const truncated = producers.length>producerCalls.length || linkTotal>links.length || unlinkedTotal>unlinkedProducerCalls.length || allDiagnostics.length>diagnostics.length;
  return {
    producerCalls,links,unlinkedProducerCalls,diagnostics,
    producerCount:count(producers.length,producerCalls.length),linkCount:count(linkTotal,links.length),
    unlinkedProducerCount:count(unlinkedTotal,unlinkedProducerCalls.length),diagnosticCount:exactProjectionCount(allDiagnostics.length,diagnostics.length),
    scanComplete,proofCoverage:{mayBeIncomplete:!scanComplete || allDiagnostics.length>0 || producers.some(p=>p.mayBeIncomplete),inspectedFiles:context.sourceFacts.length},
    evidenceState:context.evidenceState,
    mayBeIncomplete:context.mayBeIncomplete || !scanComplete || allDiagnostics.length>0 || producers.some(p=>p.mayBeIncomplete) || truncated,
    reasons:[...reasons,...(truncated ? ["projection_truncated"] : [])],truncated,limit,
    runtimeLimitation:MESSAGE_RUNTIME_LIMITATION,
    absenceStatement:"No proven producer calls in inspected evidence does not establish repository-wide producer absence.",
  };
}

export async function queryMessageLinks(repoPath: string, input: MessageLinksInput = {}) {
  return buildMessageLinks(await loadIndexedMessageGraphReadOnly(repoPath), input);
}
