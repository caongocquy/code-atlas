import type {
  BindingSeedFact,
  DeclaredTypeAnnotationFact,
  ExpressionFact,
  FactLocalId,
  ImportFact,
  MaterializedFileFacts,
  ParsedFactsBlob,
  ParsedSymbolFact,
} from "../../facts/facts.types.js";
import type { SyntaxObservation } from "../../facts/objective-syntax.types.js";
import type { CodeGraph, GraphNode } from "../types.js";
import type {
  DetectMessageProducersResult,
  MessageProducerCall,
  MessageProducerDestination,
  MessageProducerFacts,
  MessageProducerKind,
} from "./message-producer-evidence.types.js";

type Range = { startLine: number; endLine: number; startColumn?: number; endColumn?: number };
type FactIndexes = {
  callSitesByRange: Map<string, ParsedFactsBlob["callSites"][number][]>;
  parametersByOwnerName: Map<string, ParsedFactsBlob["parameters"]>;
  bindingsByName: Map<string, BindingSeedFact[]>;
  bindingsById: Map<string, BindingSeedFact>;
  annotationsByOwner: Map<string, DeclaredTypeAnnotationFact[]>;
  importsByLocalName: Map<string, ImportFact[]>;
  referencesById: Map<string, ParsedFactsBlob["references"][number]>;
  expressionsById: Map<string, ExpressionFact>;
  symbolsById: Map<string, ParsedSymbolFact>;
  symbolsByName: Map<string, ParsedSymbolFact[]>;
  referencesByName: Map<string, ParsedFactsBlob["references"][number][]>;
  scopesById: Map<string, ParsedFactsBlob["containmentScopes"][number]>;
  scopeAncestors: Map<string, Set<string>>;
  declaredTypeNames: Set<string>;
  aliasesByName: Set<string>;
  constructorSymbolIds: Set<string>;
};

function grouped<T>(items: readonly T[], key: (item: T) => string): Map<string, T[]> {
  const result = new Map<string, T[]>();
  for (const item of items) {
    const id = key(item);
    const group = result.get(id);
    if (group) group.push(item);
    else result.set(id, [item]);
  }
  return result;
}

function createFactIndexes(facts: ParsedFactsBlob): FactIndexes {
  const scopesById = new Map(facts.containmentScopes.map((item) => [item.localId, item]));
  const scopeAncestors = new Map<string, Set<string>>();
  for (const scope of facts.containmentScopes) {
    const ancestors = new Set<string>();
    for (let current: string | undefined = scope.localId; current;) {
      if (ancestors.has(current)) break;
      ancestors.add(current);
      current = scopesById.get(current as FactLocalId)?.parentId;
    }
    scopeAncestors.set(scope.localId, ancestors);
  }
  return {
    callSitesByRange: grouped(facts.callSites, (item) => JSON.stringify(item.range)),
    parametersByOwnerName: grouped(facts.parameters, (item) => `${item.ownerSymbolId}\0${item.name}`),
    bindingsByName: grouped(facts.bindingSeeds, (item) => item.name),
    bindingsById: new Map(facts.bindingSeeds.map((item) => [item.localId, item])),
    annotationsByOwner: grouped(facts.declaredTypeAnnotations, (item) => item.ownerId),
    importsByLocalName: grouped(facts.imports.filter((item) => item.localName !== undefined), (item) => item.localName!),
    referencesById: new Map(facts.references.map((item) => [item.localId, item])),
    expressionsById: new Map(facts.expressions.map((item) => [item.localId, item])),
    symbolsById: new Map(facts.symbols.map((item) => [item.localId, item])),
    symbolsByName: grouped(facts.symbols, (item) => item.name),
    referencesByName: grouped(facts.references, (item) => item.name),
    scopesById,
    scopeAncestors,
    declaredTypeNames: new Set(facts.symbols.filter((item) => ["class", "interface", "type", "enum"].includes(item.kind)).map((item) => item.name)),
    aliasesByName: new Set(facts.aliases.map((item) => item.aliasName)),
    constructorSymbolIds: new Set(facts.symbols.filter((symbol) => symbol.name === "constructor"
      || facts.containmentScopes.some((scope) => scope.kind === "constructor_declaration"
        && scope.range.startLine === symbol.range.startLine && scope.range.endLine === symbol.range.endLine
        && scope.range.startColumn === symbol.range.startColumn && scope.range.endColumn === symbol.range.endColumn)).map((item) => item.localId)),
  };
}

function sameRange(left: Range, right: Range): boolean {
  return left.startLine === right.startLine && left.endLine === right.endLine
    && left.startColumn === right.startColumn && left.endColumn === right.endColumn;
}

function bySource(left: MessageProducerCall, right: MessageProducerCall): number {
  return left.sourceCallable.file.localeCompare(right.sourceCallable.file)
    || (left.sourceCallable.startLine ?? 0) - (right.sourceCallable.startLine ?? 0)
    || left.sourceCallable.name.localeCompare(right.sourceCallable.name)
    || left.callRef.range.startLine - right.callRef.range.startLine
    || (left.callRef.range.startColumn ?? 0) - (right.callRef.range.startColumn ?? 0)
    || left.apiKind.localeCompare(right.apiKind)
    || left.destination.value.localeCompare(right.destination.value)
    || left.callRef.callId.localeCompare(right.callRef.callId);
}

function sourceCallableFor(
  callables: Map<string, GraphNode[]>,
  file: string,
  symbolId: string | undefined,
  indexes: FactIndexes,
): GraphNode | undefined {
  if (!symbolId) return undefined;
  const symbol = indexes.symbolsById.get(symbolId);
  if (!symbol || !["function", "method"].includes(symbol.kind)) return undefined;
  const candidates = callables.get(`${file}\0${symbol.name}\0${symbol.range.startLine}\0${symbol.range.endLine}`) ?? [];
  return candidates.length === 1 ? candidates[0] : undefined;
}

function importForType(
  facts: ParsedFactsBlob,
  indexes: FactIndexes,
  localName: string,
  importedName: string,
  moduleSpecifier: string,
): ImportFact | undefined {
  const named = indexes.importsByLocalName.get(localName) ?? [];
  if (named.length !== 1) return undefined;
  const item = named[0]!;
  const conflictingDeclaration = indexes.aliasesByName.has(localName) || indexes.declaredTypeNames.has(localName);
  return !conflictingDeclaration && item.importedName === importedName && item.moduleSpecifier === moduleSpecifier ? item : undefined;
}

function syntaxIndex(facts: ParsedFactsBlob): Map<string, SyntaxObservation> {
  return new Map((facts.frameworkSyntax?.nodes ?? []).map((item) => [item.id, item]));
}

function callSitesFor(indexes: FactIndexes, call: SyntaxObservation) {
  return (indexes.callSitesByRange.get(JSON.stringify(call.range)) ?? []).filter((item) => sameRange(item.range, call.range));
}

function exactSimpleStringArgument(text: string, receiver: string, method: "send" | "emit", value: unknown): string | undefined {
  if (typeof value !== "string" || value.length === 0) return undefined;
  const escapedReceiver = receiver.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const escapedMethod = method;
  const match = new RegExp(`^${escapedReceiver}\\.${escapedMethod}\\s*\\(\\s*(["'])([^\\\\"'\r\n]*)\\1\\s*,`).exec(text);
  return match?.[2] === value ? value : undefined;
}

function hasUnsupportedNestScopeBinding(
  indexes: FactIndexes,
  binding: BindingSeedFact,
  receiverName: string,
  callScopeId: string | undefined,
): boolean {
  const callScopes = scopesForCall(indexes, callScopeId);
  return (indexes.bindingsByName.get(receiverName) ?? []).some((item) => item.name === receiverName
    && item.localId !== binding.localId
    && callScopes.has(item.ownerId ?? ""));
}

function isConstructorCallable(indexes: FactIndexes, symbolId: string | undefined): boolean {
  return indexes.constructorSymbolIds.has(symbolId ?? "");
}

function detectNest(
  fileFacts: MaterializedFileFacts,
  callables: Map<string, GraphNode[]>,
  generationId: string,
  diagnostics: DetectMessageProducersResult["diagnostics"],
): MessageProducerCall[] {
  const { facts } = fileFacts;
  const syntax = facts.frameworkSyntax;
  if (facts.language !== "typescript" || !syntax) return [];
  const byId = syntaxIndex(facts);
  const indexes = createFactIndexes(facts);
  const producers: MessageProducerCall[] = [];
  for (const call of syntax.nodes.filter((item) => item.kind === "call" && (item.name === "send" || item.name === "emit"))) {
    const siteMatches = callSitesFor(indexes, call);
    const callId = siteMatches.length === 1 ? siteMatches[0]!.localId : undefined;
    const reject = (code: string, proof: "ambiguous" | "unknown" = "unknown") => diagnostics.push({ file: fileFacts.relativePath, code, receiverProof: proof, callId, range: call.range });
    if (siteMatches.length !== 1 || !syntax.complete || facts.parseStatus !== "complete") { reject("call_provenance_incomplete"); continue; }
    if (isConstructorCallable(indexes, call.ownerSymbolId)) { reject("constructor_receiver_out_of_scope"); continue; }
    if (call.arguments.length !== 2 || !call.receiverId) { reject("unsupported_call_shape"); continue; }
    const receiver = byId.get(call.receiverId);
    if (!receiver || receiver.kind !== "identifier" || !receiver.name || receiver.ownerScopeId !== call.ownerScopeId) { reject("unsupported_receiver_shape"); continue; }
    const parameter = indexes.parametersByOwnerName.get(`${call.ownerSymbolId}\0${receiver.name}`) ?? [];
    if (parameter.length !== 1 || !parameter[0]!.bindingId) { reject(parameter.length > 1 ? "ambiguous_receiver_binding" : "receiver_not_method_parameter", parameter.length > 1 ? "ambiguous" : "unknown"); continue; }
    const candidateBinding = indexes.bindingsById.get(parameter[0]!.bindingId);
    const binding = candidateBinding && candidateBinding.name === receiver.name && candidateBinding.bindingKind === "parameter" ? [candidateBinding] : [];
    const annotations = (indexes.annotationsByOwner.get(parameter[0]!.bindingId) ?? []).filter((item) => item.text === parameter[0]!.typeText);
    const typeName = parameter[0]!.typeText;
    if (binding.length !== 1 || annotations.length !== 1 || !typeName || !/^[A-Za-z_$][\w$]*$/.test(typeName)
      || !scopesForCall(indexes, call.ownerScopeId).has(binding[0]?.ownerId ?? "")
      || hasUnsupportedNestScopeBinding(indexes, binding[0]!, receiver.name, call.ownerScopeId)) {
      reject("receiver_binding_or_type_ambiguous", "ambiguous"); continue;
    }
    const ownerFact = indexes.symbolsById.get(call.ownerSymbolId ?? "");
    if (ownerFact?.kind !== "method") { reject("nest_receiver_owner_not_method"); continue; }
    const imported = importForType(facts, indexes, typeName, "ClientProxy", "@nestjs/microservices");
    if (!imported) { reject("receiver_type_import_unproven"); continue; }
    const expression = call.factId ? indexes.expressionsById.get(call.factId) : undefined;
    if (!expression || expression.kind !== "call" || !expression.text || !sameRange(expression.range, call.range)) { reject("call_expression_fact_missing"); continue; }
    const literal = byId.get(call.arguments[0]!.valueId);
    const second = byId.get(call.arguments[1]!.valueId);
    const value = literal?.kind === "literal"
      ? exactSimpleStringArgument(expression.text, receiver.name, call.name as "send" | "emit", literal.value)
      : undefined;
    if (!literal || literal.kind !== "literal" || !second || !value) { reject("whole_destination_literal_unproven"); continue; }
    const sourceCallable = sourceCallableFor(callables, fileFacts.relativePath, call.ownerSymbolId, indexes);
    if (!sourceCallable) { reject("source_callable_unbound", "ambiguous"); continue; }
    const reference = indexes.referencesById.get(receiver.factId ?? "");
    if (reference?.name !== receiver.name || reference.scopeId !== receiver.ownerScopeId) { reject("receiver_reference_unbound"); continue; }
    const method = call.name as "send" | "emit";
    const producerKind: MessageProducerKind = method === "send" ? "request" : "event";
    const destination: MessageProducerDestination = { protocolKind: "unspecified", destinationKind: "pattern", value, transport: "unknown" };
    producers.push({ sourceCallable, callRef: { generationId, file: fileFacts.relativePath, callId: siteMatches[0]!.localId, syntaxId: call.id, range: call.range },
      apiKind: method === "send" ? "client_proxy_send" : "client_proxy_emit", producerKind, receiverProof: "exact", wholeArgumentProof: "exact", destination,
      provenance: { receiverDeclarationId: binding[0]!.localId, typeAnnotationId: annotations[0]!.localId, importId: imported.localId, receiverSyntaxId: receiver.id, literalSyntaxId: literal.id },
      mayBeIncomplete: true, reasons: ["nestjs_transport_unknown"] });
  }
  return producers;
}

function scopesForCall(indexes: FactIndexes, scopeId: string | undefined): Set<string> {
  return indexes.scopeAncestors.get(scopeId ?? "") ?? new Set();
}

function javaTypeProof(facts: ParsedFactsBlob, indexes: FactIndexes, typeText: string | undefined): ImportFact | undefined | null {
  const normalized = typeText?.trim();
  const match = normalized && /^(KafkaTemplate|org\.springframework\.kafka\.core\.KafkaTemplate)(?:\s*<[^<>]+>)?$/.exec(normalized);
  if (!match) return null;
  if (match[1]!.includes(".")) return undefined;
  return importForType(facts, indexes, "KafkaTemplate", "KafkaTemplate", "org.springframework.kafka.core.KafkaTemplate") ?? null;
}

function fieldTypeAnnotation(indexes: FactIndexes, name: string, typeText: string | undefined): DeclaredTypeAnnotationFact | undefined {
  if (!typeText) return undefined;
  const symbols = indexes.symbolsByName.get(name) ?? [];
  const variableIds = new Set(symbols.filter((symbol) => symbol.kind === "variable").map((symbol) => symbol.localId));
  const declarations = [...variableIds].flatMap((id) => indexes.annotationsByOwner.get(id) ?? []).filter((item) => item.text.trim() === typeText.trim());
  return declarations.length === 1 ? declarations[0] : undefined;
}

function javaReceiverDeclaration(
  facts: ParsedFactsBlob,
  indexes: FactIndexes,
  call: SyntaxObservation,
  receiver: SyntaxObservation,
): { binding: BindingSeedFact; annotation: DeclaredTypeAnnotationFact; imported?: ImportFact } | undefined {
  if (!receiver.name || !call.ownerScopeId) return undefined;
  const scopes = scopesForCall(indexes, call.ownerScopeId);
  const parameterCandidates = indexes.parametersByOwnerName.get(`${call.ownerSymbolId}\0${receiver.name}`) ?? [];
  if (parameterCandidates.length > 1) return undefined;
  if (parameterCandidates.length === 1) {
    const parameter = parameterCandidates[0]!;
    const candidateBinding = indexes.bindingsById.get(parameter.bindingId ?? "");
    const binding = candidateBinding?.name === receiver.name && candidateBinding.bindingKind === "parameter" ? candidateBinding : undefined;
    const annotation = (indexes.annotationsByOwner.get(parameter.bindingId ?? "") ?? []).filter((item) => item.text.trim() === parameter.typeText?.trim());
    const imported = javaTypeProof(facts, indexes, parameter.typeText);
    if (binding && annotation.length === 1 && imported !== null) return { binding, annotation: annotation[0]!, imported };
    return undefined;
  }
  const fieldBindings = (indexes.bindingsByName.get(receiver.name) ?? []).filter((item) => item.bindingKind === "field" && scopes.has(item.ownerId ?? ""));
  if (fieldBindings.length !== 1) return undefined;
  const binding = fieldBindings[0]!;
  const fieldSymbols = (indexes.symbolsByName.get(receiver.name) ?? []).filter((item) => item.kind === "variable"
    && item.range.startLine === binding.range.startLine && item.range.startColumn === binding.range.startColumn);
  if (fieldSymbols.length !== 1) return undefined;
  const annotation = fieldTypeAnnotation(indexes, receiver.name, indexes.annotationsByOwner.get(fieldSymbols[0]!.localId)?.[0]?.text);
  const imported = javaTypeProof(facts, indexes, annotation?.text);
  if (!annotation || annotation.ownerId !== fieldSymbols[0]!.localId || imported === null) return undefined;
  return { binding, annotation, imported };
}

function javaLiteralIsWholeArgument(
  call: SyntaxObservation,
  children: SyntaxObservation[],
  method: SyntaxObservation,
  literal: SyntaxObservation,
  second: SyntaxObservation,
): string | undefined {
  if (literal.kind !== "literal" || typeof literal.value !== "string" || !/^[\x20-\x7e]+$/.test(literal.value)
    || literal.range.startColumn === undefined || literal.range.endColumn === undefined
    || literal.range.endColumn - literal.range.startColumn !== literal.value.length + 2
    || literal.range.startLine !== method.range.endLine || literal.range.endLine !== method.range.endLine
    || literal.range.startColumn !== (method.range.endColumn ?? -10) + 1
    || second.range.startLine !== literal.range.endLine
    || second.range.startColumn === undefined || literal.range.endColumn === undefined) return undefined;
  const gap = second.range.startColumn - literal.range.endColumn;
  if (gap < 1 || gap > 3) return undefined;
  if (children.some((item) => item.id !== literal.id && item.id !== second.id && item.kind !== "identifier" && item.range.startLine === literal.range.endLine
    && item.range.startColumn !== undefined && item.range.endColumn !== undefined
    && item.range.startColumn >= literal.range.endColumn! && item.range.endColumn <= second.range.startColumn!)) return undefined;
  if (children.some((item) => item.id !== literal.id && item.id !== second.id && item.range.startLine === literal.range.endLine
    && item.range.startColumn !== undefined && item.range.startColumn >= literal.range.endColumn!
    && item.range.startColumn < second.range.startColumn!)) return undefined;
  return literal.value;
}

function detectJava(
  fileFacts: MaterializedFileFacts,
  callables: Map<string, GraphNode[]>,
  generationId: string,
  diagnostics: DetectMessageProducersResult["diagnostics"],
): MessageProducerCall[] {
  const { facts } = fileFacts;
  const syntax = facts.frameworkSyntax;
  if (facts.language !== "java" || !syntax) return [];
  const byId = syntaxIndex(facts);
  const indexes = createFactIndexes(facts);
  const producers: MessageProducerCall[] = [];
  for (const call of syntax.nodes.filter((item) => item.kind === "call" && (item.name === "send" || item.name === "sendDefault"))) {
    const siteMatches = callSitesFor(indexes, call);
    const callId = siteMatches.length === 1 ? siteMatches[0]!.localId : undefined;
    const reject = (code: string, proof: "ambiguous" | "unknown" = "unknown") => diagnostics.push({ file: fileFacts.relativePath, code, receiverProof: proof, callId, range: call.range });
    if (siteMatches.length !== 1 || !syntax.complete || facts.parseStatus !== "complete") { reject("call_provenance_incomplete"); continue; }
    if (isConstructorCallable(indexes, call.ownerSymbolId)) { reject("constructor_receiver_out_of_scope"); continue; }
    if (call.name === "sendDefault") { reject("unsupported_kafka_api"); continue; }
    if (call.arguments.length !== 2 || !call.receiverId) { reject("unsupported_call_shape"); continue; }
    const receiver = byId.get(call.receiverId);
    const method = call.children.map((id) => byId.get(id)).find((item) => item?.kind === "identifier" && item.name === "send");
    const literal = byId.get(call.arguments[0]!.valueId);
    const second = byId.get(call.arguments[1]!.valueId);
    if (!receiver || receiver.kind !== "identifier" || !receiver.name || !method || !literal || !second) { reject("unsupported_receiver_or_arguments"); continue; }
    const declaration = javaReceiverDeclaration(facts, indexes, call, receiver);
    if (!declaration) { reject("receiver_binding_or_type_unproven", "ambiguous"); continue; }
    const receiverScopes = scopesForCall(indexes, call.ownerScopeId);
    const classScope = declaration.binding.ownerId;
    if ((indexes.bindingsByName.get(receiver.name) ?? []).some((item) => item.name === receiver.name && item.localId !== declaration.binding.localId
      && item.bindingKind !== "field" && receiverScopes.has(item.ownerId ?? ""))
      || (indexes.referencesByName.get(receiver.name) ?? []).some((item) => item.name === receiver.name && item.scopeId !== classScope
        && receiverScopes.has(item.scopeId ?? "") && item.range.startLine === call.range.startLine
        && (item.range.startColumn ?? 0) < (call.range.startColumn ?? 0))) {
      reject("shadowed_receiver_binding", "ambiguous"); continue;
    }
    const children = call.children.map((id) => byId.get(id)).filter((item): item is SyntaxObservation => !!item);
    const value = javaLiteralIsWholeArgument(call, children, method, literal, second);
    if (!value) { reject("whole_destination_literal_unproven"); continue; }
    const sourceCallable = sourceCallableFor(callables, fileFacts.relativePath, call.ownerSymbolId, indexes);
    if (!sourceCallable) { reject("source_callable_unbound", "ambiguous"); continue; }
    const receiverFact = receiver.factId ? indexes.expressionsById.get(receiver.factId) : undefined;
    const isSimpleReceiver = receiverFact?.text === receiver.name
      || (declaration.binding.bindingKind === "field" && receiverFact?.text === `this.${receiver.name}`);
    if (!receiverFact || receiverFact.kind !== "identifier" || !isSimpleReceiver) { reject("receiver_reference_unbound"); continue; }
    producers.push({ sourceCallable, callRef: { generationId, file: fileFacts.relativePath, callId: siteMatches[0]!.localId, syntaxId: call.id, range: call.range },
      apiKind: "kafka_template_send", producerKind: "event", receiverProof: "exact", wholeArgumentProof: "exact",
      destination: { protocolKind: "kafka", destinationKind: "topic", value },
      provenance: { receiverDeclarationId: declaration.binding.localId, typeAnnotationId: declaration.annotation.localId, ...(declaration.imported ? { importId: declaration.imported.localId } : {}), receiverSyntaxId: receiver.id, literalSyntaxId: literal.id },
      mayBeIncomplete: false, reasons: [] });
  }
  return producers;
}

export function detectMessageProducers(
  sourceFacts: MessageProducerFacts,
  graph: CodeGraph,
  generationId: string,
): DetectMessageProducersResult {
  const diagnostics: DetectMessageProducersResult["diagnostics"] = [];
  const callables = grouped(graph.nodes.filter((node) => node.type === "function" || node.type === "method"),
    (node) => `${node.file}\0${node.name}\0${node.startLine}\0${node.endLine}`);
  const producers = sourceFacts.flatMap((fileFacts) => fileFacts.facts.language === "typescript"
    ? detectNest(fileFacts, callables, generationId, diagnostics)
    : fileFacts.facts.language === "java"
      ? detectJava(fileFacts, callables, generationId, diagnostics)
      : []);
  producers.sort(bySource);
  diagnostics.sort((left, right) => left.file.localeCompare(right.file)
    || (left.range?.startLine ?? 0) - (right.range?.startLine ?? 0)
    || (left.range?.startColumn ?? 0) - (right.range?.startColumn ?? 0)
    || left.code.localeCompare(right.code));
  return { producers, diagnostics };
}
