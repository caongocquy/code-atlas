import { performance } from "node:perf_hooks";
import { resolveWorkspaceMembership } from "./workspace-membership.js";
import { coordinateWorkspaceMembers, createWorkspaceBudget } from "./workspace-coordinator.js";
import { WORKSPACE_BOUNDS, WORKSPACE_CONSISTENCY, WorkspaceMapError } from "./workspace.types.js";
import { checkWorkspaceDeadline, reserveWorkspaceRead } from "../../storage/atlas/workspace-metadata.reader.js";
import { readWorkspaceMessaging, roleCoverage } from "../../storage/atlas/workspace-messaging.reader.js";
import { messageCompatibility, MessageLinksError } from "../graph/intelligence/message-links.service.js";
import { exactProjectionCount } from "../projection/known-collection.js";
import type { MessageProducerCall } from "../graph/intelligence/message-producer-evidence.types.js";
import type { RepositoryMessageConsumerEntry } from "../graph/intelligence/repository-entry-catalog.types.js";
import type { WorkspaceMessageLinksInput, WorkspaceMessagingInputs, WorkspaceMessageMember, WorkspaceMessageDiagnostic,
  WorkspaceMessageLink, WorkspaceProducerRecord, WorkspaceProducerSource } from "./workspace-message-links.types.js";

export const WORKSPACE_MESSAGE_LIMITATION = "Statically compatible declared producer/consumer mapping within the selected workspace. Delivery, runtime reachability, broker/Kafka cluster, Nest transport, deployment environment, tenant/vhost, ACL and configuration compatibility are unverified.";
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
const complete = (c: WorkspaceMessageMember["producerCoverage"]) => c.status === "supported" && c.scanComplete;
function bucketKey(protocol: string, destinationKind: string, value: string, consumerKind: string, framework: string): string {
  return JSON.stringify([protocol, destinationKind, value, consumerKind, framework]);
}
function validate(input: WorkspaceMessageLinksInput) {
  const keys = ["repositories", "workspacePath", "sourceRepositoryId", "targetRepositoryId", "producerSymbol", "consumerId", "protocolKind", "destination", "limit", "detail"];
  if (!input || typeof input !== "object" || Array.isArray(input) || Object.keys(input).some(k => !keys.includes(k))) throw new WorkspaceMapError("invalid_arguments", "Invalid workspace messaging input.");
  for (const key of ["sourceRepositoryId", "targetRepositoryId", "producerSymbol", "consumerId", "destination"] as const) {
    const value = input[key];
    if (value !== undefined && (typeof value !== "string" || !value || value.length > WORKSPACE_BOUNDS.maxPathLength || value.includes("\0"))) throw new WorkspaceMapError("invalid_arguments", `Invalid ${key}.`);
  }
  if (input.producerSymbol !== undefined && input.sourceRepositoryId === undefined) throw new WorkspaceMapError("invalid_arguments", "producerSymbol requires sourceRepositoryId.");
  if (input.consumerId !== undefined && input.targetRepositoryId === undefined) throw new WorkspaceMapError("invalid_arguments", "consumerId requires targetRepositoryId.");
  if (input.sourceRepositoryId !== undefined && input.sourceRepositoryId === input.targetRepositoryId) throw new WorkspaceMapError("invalid_arguments", "Workspace messaging only composes distinct repositories.");
  if (input.protocolKind !== undefined && !["unspecified", "kafka"].includes(input.protocolKind)) throw new WorkspaceMapError("invalid_arguments", "Unsupported producer protocol.");
  const limit = input.limit ?? WORKSPACE_BOUNDS.defaultDetailLimit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKSPACE_BOUNDS.maxDetailLimit || (input.detail !== undefined && !["compact", "full"].includes(input.detail))) throw new WorkspaceMapError("invalid_arguments", "Invalid limit/detail.");
  return limit;
}

export async function queryWorkspaceMessageLinks(input: WorkspaceMessageLinksInput, options: { cwd?: string; now?: () => number } = {}) {
  const limit = validate(input);
  const now = options.now ?? (() => performance.now());
  const budget = createWorkspaceBudget(now, WORKSPACE_BOUNDS);
  const selected = await resolveWorkspaceMembership(input, options.cwd ?? process.cwd(), budget);
  const ids = new Set(selected.identities.map(i => i.id));
  for (const id of [input.sourceRepositoryId, input.targetRepositoryId]) if (id !== undefined && !ids.has(id)) throw new WorkspaceMapError("invalid_arguments", "Endpoint repository ID is not a selected workspace member.");
  const inputs = new Map<string, WorkspaceMessagingInputs>();
  const coordinated = await coordinateWorkspaceMembers(selected.identities, budget, (database, snapshot, identity, inspectedRecords) => {
    inputs.set(identity.id, readWorkspaceMessaging(database, snapshot, identity.id, budget, inspectedRecords, input));
  });
  const repositories: WorkspaceMessageMember[] = coordinated.repositories.map(member => {
    const data = inputs.get(member.repositoryId);
    const producerCoverage = data?.producerCoverage ?? roleCoverage(input.sourceRepositoryId === undefined || input.sourceRepositoryId === member.repositoryId);
    const consumerCoverage = data?.consumerCoverage ?? roleCoverage(input.targetRepositoryId === undefined || input.targetRepositoryId === member.repositoryId);
    if (!data) for (const role of [producerCoverage, consumerCoverage]) if (role.status !== "not_requested") role.reasons = [...member.health.diagnostics];
    const diagnostics: WorkspaceMessageDiagnostic[] = [...new Map([
      ...member.health.diagnostics.map(code => ({ repositoryId: member.repositoryId, ...(member.generationId ? { generationId: member.generationId } : {}), role: "member" as const, code })),
      ...(data?.diagnostics ?? []).map(({ repositoryId, generationId, role, code }) => ({ repositoryId, generationId, role, code })),
    ].map(d => [JSON.stringify([d.role,d.code]),d])).values()];
    const requested = [producerCoverage,consumerCoverage].filter(c => c.status !== "not_requested");
    const health = member.generationId === null ? member.health : {
      ...member.health,
      availability: requested.length > 0 && requested.every(c => c.status === "unavailable") ? "unavailable" as const
        : requested.length > 0 && requested.every(c => c.status === "unsupported") ? "incompatible" as const
        : requested.some(c => !complete(c)) ? "partial" as const : member.health.availability,
      compatibility: requested.length > 0 && requested.every(c => c.status === "unsupported") ? "incompatible" as const : member.health.compatibility,
      diagnostics: [...new Set([...member.health.diagnostics,...diagnostics.map(d => d.code)])].sort(),
    };
    return { ...member, health, producerCoverage, consumerCoverage, diagnostics };
  });
  const sourceMembers = repositories.filter(m => input.sourceRepositoryId === undefined || m.repositoryId === input.sourceRepositoryId);
  const targetMembers = repositories.filter(m => input.targetRepositoryId === undefined || m.repositoryId === input.targetRepositoryId);
  let selectedSourceId: string | undefined;
  if (input.producerSymbol !== undefined) {
    const data = inputs.get(input.sourceRepositoryId!);
    const matches = data?.callables.filter(n => [n.id, n.name, n.qualifiedName, `${n.file}:${n.name}`, ...(n.qualifiedName ? [`${n.file}:${n.qualifiedName}`] : [])].includes(input.producerSymbol)) ?? [];
    const unique = [...new Map(matches.map(n => [n.id, n])).values()];
    if (unique.length === 1) {
      if (!["function", "method"].includes(unique[0].type)) throw new WorkspaceMapError("invalid_arguments", "Producer selector must identify a callable.");
      selectedSourceId = unique[0].id;
    }
    else if (sourceMembers.every(m => complete(m.producerCoverage))) throw new MessageLinksError(unique.length > 1 ? "ambiguous" : "not_found", "Producer selector must identify one exact callable in sourceRepositoryId.");
  }
  if (input.consumerId !== undefined && !inputs.get(input.targetRepositoryId!)?.consumers.some(c => c.id === input.consumerId) && targetMembers.every(m => complete(m.consumerCoverage))) throw new MessageLinksError("not_found", "Consumer ID does not exist in targetRepositoryId.");
  type Target = { member: WorkspaceMessageMember; consumer: RepositoryMessageConsumerEntry };
  const buckets = new Map<string, { targets: Target[]; perRepository: Map<string, number> }>();
  for (const member of targetMembers) for (const consumer of inputs.get(member.repositoryId)?.consumers ?? []) {
    if (input.consumerId !== undefined && consumer.id !== input.consumerId) continue;
    const key = bucketKey(consumer.protocolKind, consumer.destinationKind, consumer.destination, consumer.consumerKind, consumer.framework);
    const bucket = buckets.get(key) ?? { targets: [], perRepository: new Map<string, number>() };
    bucket.targets.push({ member, consumer }); bucket.perRepository.set(member.repositoryId, (bucket.perRepository.get(member.repositoryId) ?? 0) + 1); buckets.set(key, bucket);
  }
  for (const bucket of buckets.values()) bucket.targets.sort((a, b) => compare(a.member.repositoryId, b.member.repositoryId) || compare(a.consumer.id, b.consumer.id));
  const producers = sourceMembers.flatMap(member => (inputs.get(member.repositoryId)?.producers ?? []).filter(p =>
    (input.producerSymbol === undefined || (selectedSourceId !== undefined && p.sourceCallable.id === selectedSourceId)) &&
    (input.protocolKind === undefined || p.destination.protocolKind === input.protocolKind) && (input.destination === undefined || p.destination.value === input.destination)).map(producer => ({ member, producer })));
  const callOrder = (p: MessageProducerCall) => JSON.stringify([p.sourceCallable.file, p.sourceCallable.qualifiedName ?? p.sourceCallable.name, p.callRef.range.startLine, p.callRef.range.startColumn ?? 0, p.callRef.syntaxId, p.callRef.callId]);
  producers.sort((a,b) => compare(a.member.repositoryId,b.member.repositoryId) || compare(callOrder(a.producer),callOrder(b.producer)) || compare(a.producer.destination.value,b.producer.destination.value));
  const producerCalls: WorkspaceProducerRecord[] = [], links: WorkspaceMessageLink[] = [], unlinkedProducerCalls: WorkspaceProducerSource[] = [];
  const allDiagnostics = repositories.flatMap<WorkspaceMessageDiagnostic>(m => [
    ...m.health.diagnostics.filter(code => !inputs.get(m.repositoryId)?.diagnostics.some(d => d.code === code)).map(code => ({ repositoryId: m.repositoryId, ...(m.generationId ? { generationId: m.generationId } : {}), role: "member" as const, code })),
    ...(inputs.get(m.repositoryId)?.diagnostics ?? []),
  ]).sort((a,b) => compare(a.repositoryId,b.repositoryId) || compare(a.role,b.role) || compare(a.code,b.code) || compare(JSON.stringify(a.ref ?? {}),JSON.stringify(b.ref ?? {})));
  let returned = 0, knownLinks = 0, knownUnlinked = 0, returnedBytes = 0;
  let outputBudgetComplete = true;
  const emit = <T>(array: T[], item: T): boolean => {
    if (returned >= limit || !outputBudgetComplete) return false;
    const bytes = Buffer.byteLength(JSON.stringify(item), "utf8");
    if (bytes > budget.remainingBytes) { outputBudgetComplete = false; return false; }
    try { reserveWorkspaceRead(budget, 0, bytes); } catch { outputBudgetComplete = false; return false; }
    returnedBytes += bytes;
    array.push(item); returned++; return true;
  };
  let joinComplete = true;
  for (const { member, producer: p } of producers) {
    try { checkWorkspaceDeadline(budget); } catch { joinComplete = false; break; }
    const key = bucketKey(p.destination.protocolKind,p.destination.destinationKind,p.destination.value,
      p.destination.protocolKind === "kafka" || p.producerKind === "event" ? "event" : "request_response",p.destination.protocolKind === "kafka" ? "spring" : "nestjs");
    const bucket = buckets.get(key);
    // Validated bucket dimensions exactly mirror messageCompatibility; totals need no pair materialization.
    const count = (bucket?.targets.length ?? 0) - (bucket?.perRepository.get(member.repositoryId) ?? 0);
    const targetsComplete = targetMembers.filter(m => m.repositoryId !== member.repositoryId).every(m => complete(m.consumerCoverage));
    knownLinks += count;
    if (count === 0 && targetsComplete) knownUnlinked++;
    const source: WorkspaceProducerSource = { repositoryId: member.repositoryId, generationId: member.generationId!, producerCallRef: p.callRef,
      sourceCallableRef: { id: p.sourceCallable.id, file: p.sourceCallable.file, name: p.sourceCallable.name, ...(p.sourceCallable.qualifiedName ? { qualifiedName: p.sourceCallable.qualifiedName } : {}) } };
    const destination = { ...p.destination, producerKind: p.producerKind };
    const sourceProducerEvidence = { repositoryId: member.repositoryId, generationId: member.generationId!, ref: p.callRef, ...(input.detail === "full" ? { proof: p.provenance } : {}) };
    if (returned < limit) {
      emit(producerCalls, { source, destination, apiKind: p.apiKind, cardinality: count > 1 ? "many" : !targetsComplete ? "unknown" : count === 1 ? "one" : "none", provenance: sourceProducerEvidence });
    }
    if (count === 0 && targetsComplete && returned < limit) { emit(unlinkedProducerCalls, source); }
    for (const { member: target, consumer } of bucket?.targets ?? []) {
      if (returned >= limit || !outputBudgetComplete) break;
      // Bucket lookup is only an optimization. The E1 predicate is the final gate.
      if (member.repositoryId === target.repositoryId || messageCompatibility(p, consumer) !== "compatible") continue;
      emit(links, { source, destination, runtimeLimitation: WORKSPACE_MESSAGE_LIMITATION, target: { repositoryId: target.repositoryId, generationId: target.generationId!, path: target.path, consumerId: consumer.id,
        bindingSummary: { subjectId: consumer.bindings[0].subjectId, bindingKind: "callable", callableKey: consumer.callableKey } },
        compatibility: { status: "compatible", scope: "workspace_cross_repo", reason: p.destination.protocolKind === "kafka" ? "equal_declared_kafka_topic" : "equal_nest_pattern_and_message_kind" },
        provenance: { sourceProducerEvidence, targetConsumerEvidence: { repositoryId: target.repositoryId, generationId: target.generationId!, consumerId: consumer.id, refs: consumer.provenance.refs, ...(input.detail === "full" ? { proof: consumer.provenance } : {}) } } });
    }
  }
  const diagnostics: WorkspaceMessageDiagnostic[] = [];
  for (const diagnostic of allDiagnostics) { if (!emit(diagnostics, diagnostic)) break; }
  const producerComplete = sourceMembers.every(m => complete(m.producerCoverage));
  const consumerComplete = targetMembers.every(m => complete(m.consumerCoverage));
  const scanComplete = producerComplete && consumerComplete && joinComplete;
  const count = (known: number, actual: number, exact: boolean) => exact ? exactProjectionCount(known,actual)
    : { total: null, returned: actual, omitted: null, truncated: known > actual, knownInspected: exactProjectionCount(known,actual) };
  const inspectedConsumers = targetMembers.reduce((n,m) => n + (inputs.get(m.repositoryId)?.consumers.length ?? 0),0);
  const truncated = !outputBudgetComplete || producers.length > producerCalls.length || knownLinks > links.length || knownUnlinked > unlinkedProducerCalls.length || allDiagnostics.length > diagnostics.length;
  return {
    workspace: selected.workspace, repositories, generationVector: repositories.map(m => ({ repositoryId: m.repositoryId, generationId: m.generationId })),
    producerCalls, links, unlinkedProducerCalls, diagnostics,
    counts: { sourceRepositories: exactProjectionCount(sourceMembers.length, sourceMembers.length),
      targetRepositories: exactProjectionCount(targetMembers.length,targetMembers.length),
      producerCalls: count(producers.length,producerCalls.length,producerComplete), consumersInspected: count(inspectedConsumers,inspectedConsumers,consumerComplete),
      compatibleLinks: count(knownLinks,links.length,scanComplete), unlinkedProducerCalls: count(knownUnlinked,unlinkedProducerCalls.length,scanComplete),
      unavailableRepositories: exactProjectionCount(repositories.filter(m => m.health.availability === "unavailable").length,repositories.filter(m => m.health.availability === "unavailable").length),
      diagnostics: count(allDiagnostics.length,diagnostics.length,scanComplete) },
    scanComplete, anyUnavailable: repositories.some(m => m.health.availability === "unavailable" || m.producerCoverage.status === "unavailable" || m.consumerCoverage.status === "unavailable"),
    anyUnknownFreshness: repositories.some(m => m.evidenceState.freshness === "unknown"),
    mayBeIncomplete: !scanComplete || truncated || allDiagnostics.length > 0 || repositories.some(m => m.evidenceState.mayBeIncomplete),
    limit, truncated, consistency: WORKSPACE_CONSISTENCY, runtimeLimitation: WORKSPACE_MESSAGE_LIMITATION,
    handoff: "Use target.path and target.consumerId with execution_flow. Compare its evidenceState.generationId to target.generationId; differing generations describe different snapshots.",
    absenceStatement: "No known compatible target does not prove absence when relevant target coverage is incomplete.",
    work: { inspectedRecords: budget.inspectedRecords, materializedBytes: budget.materializedBytes, returnedBytes, outputBudgetComplete, joinComplete }
  };
}
