import { factBlobKey } from "./facts-identity.js";
import type {
  FactBlobKey,
  ParsedFactsBlob,
  ParserIdentity,
} from "./facts.types.js";
import {
  LANGUAGE_IDS,
  type SupportedLanguage,
  type SymbolType,
} from "../graph/parsers/types.js";

export type FactCacheLookup =
  | { kind: "hit"; facts: ParsedFactsBlob }
  | {
      kind: "miss";
      reason:
        | "absent"
        | "invalid_json"
        | "schema_mismatch"
        | "hash_mismatch"
        | "version_mismatch"
        | "parser_identity_mismatch";
    };

export type FactCacheExpectation = {
  key: FactBlobKey;
  contentHash: string;
  language: SupportedLanguage;
  parserIdentity: ParserIdentity;
  factsVersion: string;
  factsSchemaVersion: string;
};

export function encodeFacts(facts: ParsedFactsBlob): string {
  return canonicalJson(facts);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasParserIdentity(value: unknown): value is ParserIdentity {
  return isRecord(value)
    && isSupportedLanguage(value.language)
    && value.runtimeName === "tree-sitter"
    && typeof value.runtimeVersion === "string"
    && typeof value.packageName === "string"
    && typeof value.grammarName === "string"
    && typeof value.grammarVersion === "string";
}

const SYMBOL_TYPES: ReadonlySet<SymbolType> = new Set([
  "class", "function", "method", "interface", "type", "enum", "variable", "route", "module",
]);

function isSupportedLanguage(value: unknown): value is SupportedLanguage {
  return typeof value === "string" && (LANGUAGE_IDS as readonly string[]).includes(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || isString(value);
}

function isFactId(value: unknown): boolean {
  return typeof value === "string"
    && /^(symbol|scope|import|export|reference|call|binding|type|expression|member|assignment|parameter|return|constructor|inheritance|implementation|alias|module|namespace):(0|[1-9]\d*)$/.test(value);
}

function isInteger(value: unknown): value is number {
  return Number.isInteger(value);
}

function isRange(value: unknown): boolean {
  if (!isRecord(value) || !isInteger(value.startLine) || !isInteger(value.endLine)) {
    return false;
  }
  const startLine = value.startLine;
  const endLine = value.endLine;
  const startColumn = value.startColumn;
  const endColumn = value.endColumn;

  if (startLine < 1
    || endLine < startLine
    || (startColumn !== undefined && (!isInteger(startColumn) || startColumn < 0))
    || (endColumn !== undefined && (!isInteger(endColumn) || endColumn < 0))) {
    return false;
  }

  return startLine !== endLine
    || startColumn === undefined
    || endColumn === undefined
    || endColumn >= startColumn;
}

function isSymbolFact(value: unknown): boolean {
  return isRecord(value)
    && isFactId(value.localId)
    && typeof value.name === "string"
    && typeof value.kind === "string"
    && SYMBOL_TYPES.has(value.kind as SymbolType)
    && isRange(value.range)
    && (value.scopeId === undefined || isFactId(value.scopeId))
    && isOptionalString(value.declaredQualifiedName);
}

function isScopeFact(value: unknown): boolean {
  return isRecord(value)
    && isFactId(value.localId)
    && typeof value.kind === "string"
    && isOptionalString(value.name)
    && (value.parentId === undefined || isFactId(value.parentId))
    && isRange(value.range);
}

function isImportFact(value: unknown): boolean {
  return isRecord(value)
    && isFactId(value.localId)
    && typeof value.moduleSpecifier === "string"
    && isOptionalString(value.importedName)
    && isOptionalString(value.localName)
    && typeof value.kind === "string"
    && isRange(value.range);
}

function isExportFact(value: unknown): boolean {
  return isRecord(value)
    && isFactId(value.localId)
    && isOptionalString(value.exportedName)
    && isOptionalString(value.localName)
    && isOptionalString(value.moduleSpecifier)
    && typeof value.kind === "string"
    && isRange(value.range);
}

function isReferenceFact(value: unknown): boolean {
  return isRecord(value)
    && isFactId(value.localId)
    && typeof value.name === "string"
    && (value.ownerId === undefined || isFactId(value.ownerId))
    && (value.scopeId === undefined || isFactId(value.scopeId))
    && isRange(value.range);
}

function isCallFact(value: unknown): boolean {
  return isRecord(value)
    && isFactId(value.localId)
    && typeof value.calleeText === "string"
    && (value.callerId === undefined || isFactId(value.callerId))
    && (value.scopeId === undefined || isFactId(value.scopeId))
    && isRange(value.range);
}

function isBindingFact(value: unknown): boolean {
  return isRecord(value)
    && isFactId(value.localId)
    && typeof value.name === "string"
    && typeof value.bindingKind === "string"
    && isOptionalString(value.sourceModule)
    && isOptionalString(value.importedName)
    && (value.ownerId === undefined || isFactId(value.ownerId))
    && isRange(value.range);
}

function isDeclaredTypeFact(value: unknown): boolean {
  return isRecord(value)
    && isFactId(value.localId)
    && isFactId(value.ownerId)
    && typeof value.text === "string"
    && isRange(value.range);
}

const EXPRESSION_KINDS = new Set(["identifier", "literal", "call", "construct", "member", "type_ref", "other"]);
const MEMBER_KINDS = new Set(["field", "method", "property"]);
const MEMBER_ACCESS = new Set(["instance", "static", "extension"]);
const ASSIGNMENT_KINDS = new Set(["declaration", "reassignment", "alias", "function_pointer"]);
const INHERITANCE_KINDS = new Set(["extends", "base", "trait", "protocol", "mixin"]);
const IMPLEMENTATION_KINDS = new Set(["implements", "interface", "trait_impl", "protocol_conformance", "extension", "mixin"]);
const ALIAS_KINDS = new Set(["import", "type", "namespace", "value"]);
const MODULE_KINDS = new Set(["file", "module", "package", "namespace"]);

function isOptionalFactId(value: unknown): boolean {
  return value === undefined || isFactId(value);
}

function isExpressionFact(value: unknown): boolean {
  return isRecord(value)
    && isFactId(value.localId)
    && typeof value.kind === "string"
    && EXPRESSION_KINDS.has(value.kind)
    && isOptionalString(value.text)
    && isOptionalFactId(value.ownerScopeId)
    && isRange(value.range);
}

function isMemberFact(value: unknown): boolean {
  return isRecord(value)
    && isFactId(value.localId)
    && isOptionalFactId(value.ownerSymbolId)
    && isOptionalFactId(value.receiverId)
    && typeof value.memberName === "string"
    && typeof value.memberKind === "string"
    && MEMBER_KINDS.has(value.memberKind)
    && typeof value.access === "string"
    && MEMBER_ACCESS.has(value.access)
    && isRange(value.range);
}

function isAssignmentFact(value: unknown): boolean {
  return isRecord(value)
    && isFactId(value.localId)
    && isFactId(value.targetId)
    && isOptionalFactId(value.sourceExpressionId)
    && isOptionalString(value.sourceName)
    && typeof value.assignmentKind === "string"
    && ASSIGNMENT_KINDS.has(value.assignmentKind)
    && isRange(value.range);
}

function isParameterFact(value: unknown): boolean {
  return isRecord(value)
    && isFactId(value.localId)
    && isFactId(value.ownerSymbolId)
    && typeof value.name === "string"
    && isOptionalFactId(value.bindingId)
    && isOptionalString(value.typeText)
    && isInteger(value.index)
    && value.index >= 0
    && (value.receiverKind === undefined || value.receiverKind === "method_receiver" || value.receiverKind === "go_receiver")
    && isRange(value.range);
}

function isReturnFact(value: unknown): boolean {
  return isRecord(value)
    && isFactId(value.localId)
    && isFactId(value.ownerSymbolId)
    && isOptionalFactId(value.expressionId)
    && isOptionalString(value.typeText)
    && isRange(value.range);
}

function isConstructorFact(value: unknown): boolean {
  return isRecord(value)
    && isFactId(value.localId)
    && isOptionalFactId(value.ownerSymbolId)
    && typeof value.constructedTypeName === "string"
    && isOptionalFactId(value.callExpressionId)
    && isOptionalFactId(value.resultBindingId)
    && isRange(value.range);
}

function isInheritanceFact(value: unknown): boolean {
  return isRecord(value)
    && isFactId(value.localId)
    && isFactId(value.subjectId)
    && typeof value.targetName === "string"
    && typeof value.relationKind === "string"
    && INHERITANCE_KINDS.has(value.relationKind)
    && isRange(value.range);
}

function isImplementationFact(value: unknown): boolean {
  return isRecord(value)
    && isFactId(value.localId)
    && isFactId(value.subjectId)
    && typeof value.targetName === "string"
    && typeof value.relationKind === "string"
    && IMPLEMENTATION_KINDS.has(value.relationKind)
    && isRange(value.range);
}

function isAliasFact(value: unknown): boolean {
  return isRecord(value)
    && isFactId(value.localId)
    && typeof value.aliasName === "string"
    && typeof value.targetName === "string"
    && isOptionalFactId(value.targetId)
    && typeof value.aliasKind === "string"
    && ALIAS_KINDS.has(value.aliasKind)
    && isRange(value.range);
}

function isModuleFact(value: unknown): boolean {
  return isRecord(value)
    && isFactId(value.localId)
    && typeof value.name === "string"
    && typeof value.moduleKind === "string"
    && MODULE_KINDS.has(value.moduleKind)
    && typeof value.exported === "boolean"
    && isRange(value.range);
}

function isNamespaceFact(value: unknown): boolean {
  return isRecord(value)
    && isFactId(value.localId)
    && typeof value.name === "string"
    && isOptionalFactId(value.ownerId)
    && isRange(value.range);
}

function isFactArray(value: unknown, item: (value: unknown) => boolean): boolean {
  return Array.isArray(value) && value.every(item);
}

function hasFactsShape(value: unknown): value is ParsedFactsBlob {
  if (!isRecord(value)) return false;

  return typeof value.factsSchemaVersion === "string"
    && typeof value.factsVersion === "string"
    && typeof value.contentHash === "string"
    && isSupportedLanguage(value.language)
    && hasParserIdentity(value.parserIdentity)
    && value.parserIdentity.language === value.language
    && (value.parseStatus === "complete" || value.parseStatus === "deterministic_partial")
    && Array.isArray(value.parserDiagnostics)
    && value.parserDiagnostics.every((item) => typeof item === "string")
    && isFactArray(value.symbols, isSymbolFact)
    && isFactArray(value.containmentScopes, isScopeFact)
    && isFactArray(value.imports, isImportFact)
    && isFactArray(value.exports, isExportFact)
    && isFactArray(value.references, isReferenceFact)
    && isFactArray(value.callSites, isCallFact)
    && isFactArray(value.bindingSeeds, isBindingFact)
    && isFactArray(value.declaredTypeAnnotations, isDeclaredTypeFact)
    && isFactArray(value.expressions, isExpressionFact)
    && isFactArray(value.members, isMemberFact)
    && isFactArray(value.assignments, isAssignmentFact)
    && isFactArray(value.parameters, isParameterFact)
    && isFactArray(value.returns, isReturnFact)
    && isFactArray(value.constructors, isConstructorFact)
    && isFactArray(value.inheritances, isInheritanceFact)
    && isFactArray(value.implementations, isImplementationFact)
    && isFactArray(value.aliases, isAliasFact)
    && isFactArray(value.modules, isModuleFact)
    && isFactArray(value.namespaces, isNamespaceFact);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sameParserIdentity(left: ParserIdentity, right: ParserIdentity): boolean {
  return left.language === right.language
    && left.runtimeName === right.runtimeName
    && left.runtimeVersion === right.runtimeVersion
    && left.packageName === right.packageName
    && left.grammarName === right.grammarName
    && left.grammarVersion === right.grammarVersion;
}

export function decodeFacts(
  payload: string | undefined,
  expected: FactCacheExpectation,
): FactCacheLookup {
  if (payload === undefined) return { kind: "miss", reason: "absent" };

  let value: unknown;
  try {
    value = JSON.parse(payload);
  } catch {
    return { kind: "miss", reason: "invalid_json" };
  }

  if (!hasFactsShape(value)) return { kind: "miss", reason: "schema_mismatch" };
  if (value.contentHash !== expected.contentHash) return { kind: "miss", reason: "hash_mismatch" };
  if (value.factsVersion !== expected.factsVersion) return { kind: "miss", reason: "version_mismatch" };
  if (value.factsSchemaVersion !== expected.factsSchemaVersion) return { kind: "miss", reason: "schema_mismatch" };
  if (value.language !== expected.language || !sameParserIdentity(value.parserIdentity, expected.parserIdentity)) {
    return { kind: "miss", reason: "parser_identity_mismatch" };
  }
  if (factBlobKey(value) !== expected.key) return { kind: "miss", reason: "hash_mismatch" };

  return { kind: "hit", facts: value };
}
