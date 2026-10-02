import type { FrameworkAnalysisContext, FrameworkDiagnostic, FrameworkEvidence, FrameworkId } from "./framework.types.js";
import type { ParsedFactsBlob } from "../facts/facts.types.js";
import type { SyntaxObservation } from "../facts/objective-syntax.types.js";
import { frameworkEnclosingClass, frameworkGraphSymbol, frameworkImportedName } from "./framework-symbol-binding.js";

export type MessageProtocolKind = "unspecified" | "kafka" | "rabbit";
export type MessageConsumerKind = "request_response" | "event";
export type MessageDestinationKind = "pattern" | "topic" | "queue";
export type MessageIdentityOptions = { id: string | null; groupId: string | null };
export type MessageIdentity = readonly [scope: string, callableKey: readonly [file: string, typePath: string, method: string], protocolKind: MessageProtocolKind, consumerKind: MessageConsumerKind, destinationKind: MessageDestinationKind, destination: string, identityOptions: MessageIdentityOptions];
export type MessageMetadata = { groupSource: "explicit" | "id" | "default" | null; concurrency: string | null; containerFactory: string | null };

export const MESSAGE_UNSUPPORTED_REASONS = ["dynamic_pattern", "unsupported_pattern", "unsupported_transport", "unsupported_message_form", "dynamic_destination", "unsupported_destination", "unsupported_options", "unsupported_topics", "unsupported_queues", "class_level_dispatch", "nested_composed_annotation", "multiple_patterns", "invalid_destination"] as const;
export type MessageUnsupportedReason = typeof MESSAGE_UNSUPPORTED_REASONS[number];
type MessageRelationshipEvidence = Extract<FrameworkEvidence, { outputKind: "relationship" }>;

const record = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 1024 && value.trim() === value && !/[\u0000-\u001f]/.test(value);
const relative = (value: unknown): value is string => text(value) && !value.includes("\\") && !value.startsWith("/") && !/^[A-Za-z]:/.test(value) && value.split("/").every((part) => part && part !== "." && part !== "..");
const onlyKeys = (value: Record<string, unknown>, expected: readonly string[]) => Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));

export function isMessageMetadata(value: unknown): value is MessageMetadata {
  return record(value) && onlyKeys(value, ["groupSource", "concurrency", "containerFactory"])
    && (["explicit", "id", "default", null] as const).includes(value.groupSource as MessageMetadata["groupSource"])
    && (value.concurrency === null || (text(value.concurrency) && !/\$\{|#\{/.test(value.concurrency)))
    && (value.containerFactory === null || (text(value.containerFactory) && !/\$\{|#\{/.test(value.containerFactory)));
}

export function decodeMessageIdentity(framework: FrameworkId, logicalKey: unknown): MessageIdentity | undefined {
  if ((framework !== "nestjs" && framework !== "spring") || typeof logicalKey !== "string") return undefined;
  try {
    const value: unknown = JSON.parse(logicalKey);
    if (!Array.isArray(value) || value.length !== 7) return undefined;
    const [scope, callableKey, protocol, consumer, destinationKind, destination, options] = value;
    if (!relative(scope) || !Array.isArray(callableKey) || callableKey.length !== 3 || !relative(callableKey[0])
      || !text(callableKey[1]) || !/^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)*$/.test(callableKey[1])
      || !text(callableKey[2]) || !/^[A-Za-z_$][\w$]*$/.test(callableKey[2]) || !text(destination)
      || !record(options) || !onlyKeys(options, ["id", "groupId"]) || !(options.id === null || text(options.id)) || !(options.groupId === null || text(options.groupId))) return undefined;
    if (framework === "nestjs") {
      if (protocol !== "unspecified" || !["request_response", "event"].includes(consumer) || destinationKind !== "pattern" || options.id !== null || options.groupId !== null) return undefined;
    } else if (protocol === "kafka") {
      if (consumer !== "event" || destinationKind !== "topic" || /\$\{|#\{/.test(destination)
        || [options.id, options.groupId].some((item) => typeof item === "string" && /\$\{|#\{/.test(item))) return undefined;
    } else if (protocol === "rabbit") {
      if (consumer !== "event" || destinationKind !== "queue" || options.groupId !== null || /\$\{|#\{/.test(destination)
        || (typeof options.id === "string" && /\$\{|#\{/.test(options.id))) return undefined;
    } else return undefined;
    const identity: MessageIdentity = [scope, callableKey as [string, string, string], protocol, consumer, destinationKind, destination, { id: options.id as string | null, groupId: options.groupId as string | null }];
    return JSON.stringify(identity) === logicalKey ? identity : undefined;
  } catch { return undefined; }
}

export function isPublishableMessageDiagnostic(diagnostic: FrameworkDiagnostic): boolean {
  const framework = diagnostic.framework;
  const capability = diagnostic.capability;
  const capabilities = framework === "nestjs" ? ["nestjs.message_pattern", "nestjs.event_pattern"]
    : framework === "spring" ? ["spring.kafka_listener", "spring.rabbit_listener"] : [];
  const allowedReason = messageReasonAllowed(framework, capability, diagnostic.reason);
  return diagnostic.code === "framework_message_unsupported" && diagnostic.outcome === "unsupported"
    && capabilities.includes(diagnostic.capability)
    && allowedReason
    && diagnostic.strategy === `messaging.${diagnostic.reason}`
    && (MESSAGE_UNSUPPORTED_REASONS as readonly string[]).includes(diagnostic.reason);
}

export function isMessageCoverage(framework: string, capability: string, strategy: string, kind: string): boolean {
  const reason = strategy.startsWith("messaging.") ? strategy.slice("messaging.".length) : "";
  return kind === "message_handler" && messageReasonAllowed(framework, capability, reason);
}

function messageReasonAllowed(framework: string, capability: string, reason: string): boolean {
  if (framework === "nestjs" && ["nestjs.message_pattern", "nestjs.event_pattern"].includes(capability))
    return ["dynamic_pattern", "unsupported_pattern", "unsupported_transport", "unsupported_message_form", "multiple_patterns", "invalid_destination"].includes(reason);
  if (framework === "spring" && capability === "spring.kafka_listener")
    return ["dynamic_destination", "unsupported_destination", "unsupported_options", "unsupported_topics", "unsupported_message_form", "class_level_dispatch", "nested_composed_annotation", "invalid_destination"].includes(reason);
  if (framework === "spring" && capability === "spring.rabbit_listener")
    return ["dynamic_destination", "unsupported_destination", "unsupported_options", "unsupported_queues", "unsupported_message_form", "class_level_dispatch", "nested_composed_annotation", "invalid_destination"].includes(reason);
  return false;
}

function callableKey(facts: ParsedFactsBlob, file: string, methodId: string | undefined): MessageIdentity[1] | undefined {
  const method = facts.symbols.find((symbol) => symbol.localId === methodId && symbol.kind === "method");
  if (!method) return undefined;
  const scopes = new Map(facts.containmentScopes.map((scope) => [scope.localId, scope]));
  const types: string[] = [];
  let scopeId = method.scopeId;
  while (scopeId) {
    const type = facts.symbols.find((symbol) => symbol.scopeId === scopeId && (symbol.kind === "class" || symbol.kind === "interface"));
    if (type) types.unshift(type.name);
    scopeId = scopes.get(scopeId)?.parentId;
  }
  return types.length ? [file, types.join("."), method.name] : undefined;
}

function base(framework: "nestjs" | "spring", relativePath: string, localId: string, capability: string, strategy: string, reason?: MessageUnsupportedReason): MessageRelationshipEvidence {
  const ref = { relativePath, inputKey: `facts:${relativePath}`, localId };
  return { evidenceId: `${framework}-message:${relativePath}:${localId}`, framework, adapterId: framework, adapterVersion: "1.4.0", strategy: reason ? `messaging.${reason}` : strategy, capability, relativePath, origin: "framework_inferred", confidence: "exact", refs: [ref], entities: [], applicable: true, supported: !reason, attempted: true, state: reason ? "unsupported" : "candidate", ...(reason ? { messageUnsupportedReason: reason } : {}), outputKind: "relationship", relationKind: "message_handler", sourceCandidates: [], targetCandidates: [] };
}

function addUnsupported(result: FrameworkEvidence[], framework: "nestjs" | "spring", relativePath: string, annotation: SyntaxObservation, capability: string, reason: MessageUnsupportedReason): void {
  result.push(base(framework, relativePath, annotation.id, capability, "", reason));
}

function nestPattern(annotation: SyntaxObservation, facts: ParsedFactsBlob, imported: string): { destination: string; consumer: "request_response" | "event" } | MessageUnsupportedReason {
  if (annotation.arguments.length !== 1) return annotation.arguments.length > 1 ? "unsupported_transport" : "unsupported_pattern";
  const syntax = facts.frameworkSyntax;
  const call = annotation.children.map((id) => syntax?.nodes.find((node) => node.id === id)).find((node) => node?.kind === "call");
  const expression = facts.expressions.find((item) => item.localId === call?.factId);
  const node = syntax?.nodes.find((item) => item.id === annotation.arguments[0]!.valueId);
  if (node?.kind !== "literal" || typeof node.value !== "string") return "dynamic_pattern";
  const raw = expression?.text;
  if (!raw) return "unsupported_pattern";
  const argumentText = raw.slice(raw.indexOf("(") + 1, raw.lastIndexOf(")")).trim();
  const quoted = /^(["'])(?:\\.|(?!\1)[^\\])*\1$/.exec(argumentText);
  if (!quoted || raw.indexOf("(") < 0 || raw.slice(0, raw.indexOf("(")).trim() !== annotation.name || !raw.endsWith(")")) return "unsupported_pattern";
  if (quoted[1] === '"') {
    try { if (JSON.parse(argumentText) !== node.value) return "unsupported_pattern"; }
    catch { return "unsupported_pattern"; }
  } else if (argumentText.slice(1, -1).includes("\\") || argumentText.slice(1, -1) !== node.value) return "unsupported_pattern";
  if (!text(node.value)) return "invalid_destination";
  return { destination: node.value, consumer: imported === "MessagePattern" ? "request_response" : "event" };
}

function adjacentJavaLiteral(annotation: SyntaxObservation, name: string, value: SyntaxObservation, nodes: Map<string, SyntaxObservation>, nextName?: string): boolean {
  const children = annotation.children.flatMap((id) => {
    const child = nodes.get(id);
    return child?.kind === "annotation" ? child.children.map((nestedId) => nodes.get(nestedId)) : [];
  });
  const label = children.find((node) => node?.kind === "identifier" && node.name === name);
  const next = nextName ? children.find((node) => node?.kind === "identifier" && node.name === nextName) : undefined;
  const result = value.kind === "literal" && (typeof value.value === "string" || (name === "idIsGroup" && typeof value.value === "boolean")) && !!label
    && label.range.startLine === value.range.startLine && label.range.endLine === value.range.endLine
    && (label.range.endColumn ?? -1) + 1 === value.range.startColumn
    && (typeof value.value !== "string" || (!value.value.includes("\\") && (value.range.endColumn ?? -1) - (value.range.startColumn ?? -1) === value.value.length + 2))
    && (next ? next.range.startLine === value.range.endLine && [1, 2].includes((next.range.startColumn ?? -1) - (value.range.endColumn ?? -1))
      : annotation.range.endLine === value.range.endLine && (value.range.endColumn ?? -1) + 1 === annotation.range.endColumn);
  return result;
}

type SpringParseResult = { destination: string; options: MessageIdentityOptions; metadata: MessageMetadata } | MessageUnsupportedReason | { unknown: true };
function springAttributes(annotation: SyntaxObservation, nodes: Map<string, SyntaxObservation>, destinationName: "topics" | "queues", protocol: "kafka" | "rabbit"): SpringParseResult {
  const allowed = protocol === "kafka" ? ["topics", "groupId", "id", "idIsGroup", "concurrency", "containerFactory"] : ["queues", "id", "concurrency", "containerFactory"];
  const args = annotation.arguments;
  const names = args.map((arg) => arg.name ?? "value");
  const knownUnsupported = protocol === "kafka" ? ["topicPattern", "topicPartitions"] : ["queuesToDeclare", "bindings", "exchange", "routingKey"];
  if (names.some((name) => !allowed.includes(name) && !knownUnsupported.includes(name))) return { unknown: true };
  if (names.some((name) => knownUnsupported.includes(name))) return protocol === "kafka" ? "unsupported_topics" : "unsupported_queues";
  if (new Set(names).size !== names.length) return "unsupported_options";
  if (protocol === "kafka" ? names.filter((name) => name === "topics").length !== 1 : names.filter((name) => name === "queues").length !== 1) return protocol === "kafka" ? "unsupported_topics" : "unsupported_queues";
  const values = new Map<string, SyntaxObservation>();
  for (const [index, argument] of args.entries()) {
    const name = argument.name ?? "value";
    const value = nodes.get(argument.valueId);
    if (!value || !adjacentJavaLiteral(annotation, name, value, nodes, names[index + 1])) return name === destinationName ? (protocol === "kafka" ? "unsupported_topics" : "unsupported_queues") : "unsupported_options";
    values.set(name, value);
  }
  const literalValue = (name: string) => values.get(name)?.value;
  const destination = literalValue(destinationName);
  if (typeof destination !== "string" || !text(destination) || /\$\{|#\{/.test(destination)) return "dynamic_destination";
  const idValue = literalValue("id");
  const explicitGroup = literalValue("groupId");
  if ((idValue !== undefined && (typeof idValue !== "string" || !text(idValue) || /\$\{|#\{/.test(idValue)))
    || (explicitGroup !== undefined && (typeof explicitGroup !== "string" || !text(explicitGroup) || /\$\{|#\{/.test(explicitGroup)))) return "unsupported_options";
  const idIsGroup = literalValue("idIsGroup");
  if (idIsGroup !== undefined && typeof idIsGroup !== "boolean") return "unsupported_options";
  const groupId = protocol === "kafka" ? typeof explicitGroup === "string" ? explicitGroup
    : typeof idValue === "string" && idValue.length > 0 && idIsGroup !== false ? idValue : null : null;
  const metadata: MessageMetadata = {
    groupSource: protocol !== "kafka" ? null : typeof explicitGroup === "string" ? "explicit" : groupId !== null ? "id" : "default",
    concurrency: typeof literalValue("concurrency") === "string" && text(literalValue("concurrency")) && !/\$\{|#\{/.test(literalValue("concurrency") as string) ? literalValue("concurrency") as string : null,
    containerFactory: typeof literalValue("containerFactory") === "string" && text(literalValue("containerFactory")) && !/\$\{|#\{/.test(literalValue("containerFactory") as string) ? literalValue("containerFactory") as string : null,
  };
  if ((values.has("concurrency") && metadata.concurrency === null) || (values.has("containerFactory") && metadata.containerFactory === null)) return "unsupported_options";
  return { destination, options: { id: typeof idValue === "string" ? idValue : null, groupId }, metadata };
}

export function collectMessageConsumerEvidence(ctx: FrameworkAnalysisContext, framework: "nestjs" | "spring"): FrameworkEvidence[] {
  const result: MessageRelationshipEvidence[] = [];
  for (const materialized of ctx.facts) {
    if (!ctx.analyzePaths.has(materialized.relativePath)) continue;
    const facts = materialized.facts;
    const syntax = facts.frameworkSyntax;
    if (!syntax) continue;
    const nodes = new Map(syntax.nodes.map((node) => [node.id, node]));
    if (framework === "nestjs") {
      const annotations = syntax.nodes.filter((node) => node.kind === "annotation" && ["MessagePattern", "EventPattern"].includes(frameworkImportedName(facts, node.name, "@nestjs/microservices") ?? ""));
      const controllers = new Set(syntax.nodes.filter((node) => node.kind === "annotation" && frameworkImportedName(facts, node.name, "@nestjs/common") === "Controller").flatMap((node) => {
        const owner = frameworkImportedName(facts, node.name, "@nestjs/common") === "Controller"
          ? frameworkGraphSymbol(ctx, materialized.relativePath, facts, node.ownerSymbolId, "class") : undefined;
        return owner ? [owner.id] : [];
      }));
      for (const annotation of annotations) {
        const imported = frameworkImportedName(facts, annotation.name, "@nestjs/microservices");
        const capability = imported === "EventPattern" ? "nestjs.event_pattern" : "nestjs.message_pattern";
        const owner = frameworkGraphSymbol(ctx, materialized.relativePath, facts, annotation.ownerSymbolId, "method");
        const ownerClass = frameworkEnclosingClass(ctx, materialized.relativePath, facts, annotation.ownerSymbolId, owner);
        const callable = callableKey(facts, materialized.relativePath, annotation.ownerSymbolId);
        const valid = !!owner && !!ownerClass && controllers.has(ownerClass.id) && !!callable && syntax.complete;
        if (annotations.filter((candidate) => candidate.ownerSymbolId === annotation.ownerSymbolId).length > 1) {
          if (valid) addUnsupported(result, framework, materialized.relativePath, annotation, capability, "multiple_patterns");
          else { const unknown = base(framework, materialized.relativePath, annotation.id, capability, "messaging.pattern"); unknown.state = "unknown"; result.push(unknown); }
          continue;
        }
        const parsed = imported ? nestPattern(annotation, facts, imported) : "unsupported_pattern";
        if (typeof parsed === "string") { if (valid) addUnsupported(result, framework, materialized.relativePath, annotation, capability, parsed); else { const unknown = base(framework, materialized.relativePath, annotation.id, capability, "messaging.pattern"); unknown.state = "unknown"; result.push(unknown); } continue; }
        if (!valid) { const unknown = base(framework, materialized.relativePath, annotation.id, capability, "messaging.pattern"); unknown.state = "unknown"; result.push(unknown); continue; }
        const capabilityIdentity: MessageIdentity = ["root", callable, "unspecified", parsed.consumer, "pattern", parsed.destination, { id: null, groupId: null }];
        const ref = { framework, kind: "message_consumer" as const, logicalKey: JSON.stringify(capabilityIdentity) };
        const item = base(framework, materialized.relativePath, annotation.id, capability, `messaging.${imported === "EventPattern" ? "event" : "message"}`);
        item.entities = [{ ref, displayName: `${callable[1]}.${callable[2]} (${parsed.consumer})`, declarationKey: item.evidenceId, confidence: "exact", refs: item.refs, messageMetadata: { groupSource: null, concurrency: null, containerFactory: null } }];
        item.sourceCandidates = [{ kind: "language", nodeId: owner.id }];
        item.targetCandidates = [{ kind: "framework", entity: ref }];
        result.push(item);
      }
      continue;
    }
    const choices = [
      { name: "KafkaListener", module: "org.springframework.kafka.annotation.KafkaListener", protocol: "kafka" as const, destination: "topics" as const, capability: "spring.kafka_listener" },
      { name: "RabbitListener", module: "org.springframework.amqp.rabbit.annotation.RabbitListener", protocol: "rabbit" as const, destination: "queues" as const, capability: "spring.rabbit_listener" },
    ];
    for (const choice of choices) {
      const annotations = syntax.nodes.filter((node) => node.kind === "annotation" && frameworkImportedName(facts, node.name, choice.module) === choice.name);
      for (const annotation of annotations) {
        if (facts.language !== "java") {
          const owner = frameworkGraphSymbol(ctx, materialized.relativePath, facts, annotation.ownerSymbolId, "method");
          const classOwner = frameworkGraphSymbol(ctx, materialized.relativePath, facts, annotation.ownerSymbolId, "class");
          const validMethod = !!owner && !!frameworkEnclosingClass(ctx, materialized.relativePath, facts, annotation.ownerSymbolId, owner) && syntax.complete;
          if (classOwner) addUnsupported(result, framework, materialized.relativePath, annotation, choice.capability, "class_level_dispatch");
          else if (validMethod) addUnsupported(result, framework, materialized.relativePath, annotation, choice.capability, "unsupported_message_form");
          else { const unknown = base(framework, materialized.relativePath, annotation.id, choice.capability, `messaging.${choice.protocol}`); unknown.state = "unknown"; result.push(unknown); }
          continue;
        }
        const parsed = springAttributes(annotation, nodes, choice.destination, choice.protocol);
        if (typeof parsed !== "string" && "unknown" in parsed) { const unknown = base(framework, materialized.relativePath, annotation.id, choice.capability, `messaging.${choice.protocol}`); unknown.state = "unknown"; result.push(unknown); continue; }
        const nested = syntax.nodes.some((parent) => parent.kind === "annotation" && parent.id !== annotation.id
          && (parent.range.startLine < annotation.range.startLine || (parent.range.startLine === annotation.range.startLine && (parent.range.startColumn ?? -1) < (annotation.range.startColumn ?? -1)))
          && (parent.range.endLine > annotation.range.endLine || (parent.range.endLine === annotation.range.endLine && (parent.range.endColumn ?? -1) > (annotation.range.endColumn ?? -1))));
        const owner = frameworkGraphSymbol(ctx, materialized.relativePath, facts, annotation.ownerSymbolId, "method");
        const classOwner = frameworkGraphSymbol(ctx, materialized.relativePath, facts, annotation.ownerSymbolId, "class");
        if (nested) { addUnsupported(result, framework, materialized.relativePath, annotation, choice.capability, "nested_composed_annotation"); continue; }
        if (classOwner) { addUnsupported(result, framework, materialized.relativePath, annotation, choice.capability, "class_level_dispatch"); continue; }
        const callable = callableKey(facts, materialized.relativePath, annotation.ownerSymbolId);
        const valid = !!owner && !!frameworkEnclosingClass(ctx, materialized.relativePath, facts, annotation.ownerSymbolId, owner) && !!callable && syntax.complete;
        if (typeof parsed === "string") { if (valid) addUnsupported(result, framework, materialized.relativePath, annotation, choice.capability, parsed); else { const unknown = base(framework, materialized.relativePath, annotation.id, choice.capability, `messaging.${choice.protocol}`); unknown.state = "unknown"; result.push(unknown); } continue; }
        if (!valid) { const unknown = base(framework, materialized.relativePath, annotation.id, choice.capability, `messaging.${choice.protocol}`); unknown.state = "unknown"; result.push(unknown); continue; }
        const consumer: MessageConsumerKind = "event";
        const identity: MessageIdentity = ["root", callable, choice.protocol, consumer, choice.protocol === "kafka" ? "topic" : "queue", parsed.destination, parsed.options];
        const ref = { framework, kind: "message_consumer" as const, logicalKey: JSON.stringify(identity) };
        const item = base(framework, materialized.relativePath, annotation.id, choice.capability, `messaging.${choice.protocol}`);
        item.entities = [{ ref, displayName: `${callable[1]}.${callable[2]} (${choice.protocol})`, declarationKey: item.evidenceId, confidence: "exact", refs: item.refs, messageMetadata: parsed.metadata }];
        item.sourceCandidates = [{ kind: "language", nodeId: owner.id }];
        item.targetCandidates = [{ kind: "framework", entity: ref }];
        result.push(item);
      }
    }
  }
  const identities = new Map<string, MessageRelationshipEvidence[]>();
  for (const item of result) for (const entity of item.entities) identities.set(entity.ref.logicalKey, [...(identities.get(entity.ref.logicalKey) ?? []), item]);
  for (const items of identities.values()) if (items.length > 1) for (const item of items) {
    item.sourceCandidates = [...item.sourceCandidates, ...item.sourceCandidates];
    item.targetCandidates = [...item.targetCandidates, ...item.targetCandidates];
  }
  return result;
}
