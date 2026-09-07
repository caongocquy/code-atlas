import Parser from "tree-sitter";

import { getLanguageAdapter } from "./parsers/registry.js";
import type { CallReference } from "./calls.js";
import type { ImportBinding } from "./import-bindings.js";
import {
  emptyResolutionCoverage,
  type ResolutionBatch,
  type ResolutionEvidence,
  type ResolutionResult,
} from "./resolution.types.js";
import type { CodeGraph, GraphEdge, GraphNode } from "./types.js";
import { maskSourceSyntax } from "./source-mask.js";

export type ObjectBinding = { localName: string; className: string; targetFile?: string };
export type ParameterBinding = { callerQualifiedName: string; localName: string; className: string; targetFile?: string };
export type ClassFieldBinding = { ownerClassName: string; fieldName: string; className: string; targetFile?: string };
export type MemberResolutionFactEvidence = true;

type MemberCallPath = { root: string; members: string[]; constructedClassName?: string };

function parseMemberCallPath(calleeName: string): MemberCallPath | undefined {
  const directNewMatch = calleeName.match(/^new\s+([A-Za-z_$][\w$]*)\s*\(\)\.([A-Za-z_$][\w$]*)$/);
  if (directNewMatch?.[1] && directNewMatch[2]) {
    return { root: directNewMatch[1], members: [directNewMatch[2]], constructedClassName: directNewMatch[1] };
  }

  const parts = calleeName.split(".").map((part) => part.trim()).filter(Boolean);
  if (parts.length < 2 || !parts[0]) return undefined;
  return { root: parts[0], members: parts.slice(1) };
}

function bindingsByLocalName(bindings: ImportBinding[]): Map<string, ImportBinding[]> {
  const result = new Map<string, ImportBinding[]>();
  for (const binding of bindings) {
    result.set(binding.localName, [...(result.get(binding.localName) ?? []), binding]);
  }
  return result;
}

function resolveClassBindings(typeName: string, filePath: string, imports: Map<string, ImportBinding[]>): Array<{ className: string; targetFile?: string }> {
  const bindings = imports.get(typeName);
  return bindings
    ? bindings.map((binding) => ({ className: binding.importedName, targetFile: binding.targetFile }))
    : [{ className: typeName, targetFile: filePath }];
}

function typedParameters(text: string): Array<{ localName: string; typeName: string; accessibility: boolean }> {
  return text.split(",").flatMap((part) => {
    const value = part.trim().replace(/\s*=.*$/, "");
    const match = value.match(/^(?:(public|private|protected)\s+)?(?:readonly\s+)?([A-Za-z_$][\w$]*)\??\s*:\s*([A-Za-z_$][\w$]*)$/);
    return match?.[2] && match[3]
      ? [{ localName: match[2], typeName: match[3], accessibility: Boolean(match[1]) }]
      : [];
  });
}

function extractFactsObjectBindings(source: string, filePath: string, importBindings: ImportBinding[]): ObjectBinding[] {
  const maskedSource = maskSourceSyntax(source);
  const imports = bindingsByLocalName(importBindings);
  const results: ObjectBinding[] = [];
  const pattern = /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*new\s+([A-Za-z_$][\w$]*)\s*\(/g;
  for (const match of maskedSource.matchAll(pattern)) {
    const localName = match[1];
    const typeName = match[2];
    if (!localName || !typeName) continue;
    for (const binding of resolveClassBindings(typeName, filePath, imports)) results.push({ localName, ...binding });
  }
  return results;
}

function extractFactsParameterBindings(source: string, filePath: string, importBindings: ImportBinding[], calls: CallReference[]): ParameterBinding[] {
  const maskedSource = maskSourceSyntax(source);
  const imports = bindingsByLocalName(importBindings);
  const results: ParameterBinding[] = [];
  const pattern = /(?:\bfunction\s+)?([A-Za-z_$][\w$]*)\s*\(([^)]*)\)/g;
  for (const match of maskedSource.matchAll(pattern)) {
    const name = match[1];
    const parameters = match[2];
    if (!name || parameters === undefined) continue;
    const callers = calls.filter((call) => call.callerQualifiedName === name || call.callerQualifiedName?.endsWith(`.${name}`));
    for (const caller of callers) {
      if (!caller.callerQualifiedName) continue;
      for (const parameter of typedParameters(parameters)) {
        for (const binding of resolveClassBindings(parameter.typeName, filePath, imports)) {
          results.push({ callerQualifiedName: caller.callerQualifiedName, localName: parameter.localName, ...binding });
        }
      }
    }
  }
  return results;
}

function extractFactsClassFieldBindings(source: string, filePath: string, importBindings: ImportBinding[]): ClassFieldBinding[] {
  const maskedSource = maskSourceSyntax(source);
  const imports = bindingsByLocalName(importBindings);
  const results: ClassFieldBinding[] = [];
  const classPattern = /\bclass\s+([A-Za-z_$][\w$]*)\b[^\{]*\{/g;
  for (const match of maskedSource.matchAll(classPattern)) {
    const ownerClassName = match[1];
    const openBrace = match.index === undefined ? -1 : maskedSource.indexOf("{", match.index);
    if (!ownerClassName || openBrace < 0) continue;
    let depth = 0;
    let closeBrace = -1;
    for (let index = openBrace; index < maskedSource.length; index += 1) {
      if (maskedSource[index] === "{") depth += 1;
      if (maskedSource[index] === "}") depth -= 1;
      if (depth === 0) {
        closeBrace = index;
        break;
      }
    }
    if (closeBrace < 0) continue;
    const body = maskedSource.slice(openBrace + 1, closeBrace);
    const constructor = body.match(/\bconstructor\s*\(([^)]*)\)/);
    const parameters = constructor?.[1];
    if (parameters === undefined) continue;
    for (const parameter of typedParameters(parameters).filter((item) => item.accessibility)) {
      for (const binding of resolveClassBindings(parameter.typeName, filePath, imports)) {
        results.push({ ownerClassName, fieldName: parameter.localName, ...binding });
      }
    }
  }
  return results;
}

function createParser(filePath: string): Parser | undefined {
  const adapter = getLanguageAdapter(filePath);
  if (!adapter) return undefined;
  const parser = new Parser();
  parser.setLanguage(adapter.grammar);
  return parser;
}

function extractObjectBindings(source: string, filePath: string, importBindings: ImportBinding[]): ObjectBinding[] {
  const parser = createParser(filePath);
  if (!parser) return [];
  const imports = bindingsByLocalName(importBindings);
  const results: ObjectBinding[] = [];

  function walk(node: Parser.SyntaxNode): void {
    if (node.type === "variable_declarator") {
      const name = node.childForFieldName("name");
      const value = node.childForFieldName("value");
      const constructor = value?.type === "new_expression" ? value.childForFieldName("constructor") : undefined;
      if (name?.type === "identifier" && constructor?.type === "identifier") {
        for (const binding of resolveClassBindings(constructor.text, filePath, imports)) {
          results.push({ localName: name.text, ...binding });
        }
      }
    }
    for (const child of node.namedChildren) walk(child);
  }
  walk(parser.parse(source).rootNode);
  return results;
}

function findContainingClassName(node: Parser.SyntaxNode): string | undefined {
  let current: Parser.SyntaxNode | null = node.parent;
  while (current) {
    if (current.type === "class_declaration") return current.childForFieldName("name")?.text;
    current = current.parent;
  }
  return undefined;
}

function getCallableQualifiedName(node: Parser.SyntaxNode): string | undefined {
  if (node.type === "function_declaration") return node.childForFieldName("name")?.text;
  if (node.type !== "method_definition") return undefined;
  const method = node.childForFieldName("name")?.text;
  const className = findContainingClassName(node);
  return method ? (className ? `${className}.${method}` : method) : undefined;
}

function extractParameterType(parameter: Parser.SyntaxNode): { localName?: string; typeName?: string } {
  const pattern = parameter.childForFieldName("pattern") ?? parameter.childForFieldName("name");
  const type = parameter.childForFieldName("type");
  if (pattern?.type === "identifier" && type) {
    const typeName = type.text.replace(/^:\s*/, "").trim();
    if (/^[A-Za-z_$][\w$]*$/.test(typeName)) return { localName: pattern.text, typeName };
  }
  const match = parameter.text.match(/^([A-Za-z_$][\w$]*)\??\s*:\s*([A-Za-z_$][\w$]*)/);
  return match ? { localName: match[1], typeName: match[2] } : {};
}

function extractParameterBindings(source: string, filePath: string, importBindings: ImportBinding[]): ParameterBinding[] {
  const parser = createParser(filePath);
  if (!parser) return [];
  const imports = bindingsByLocalName(importBindings);
  const results: ParameterBinding[] = [];
  function walk(node: Parser.SyntaxNode): void {
    if (node.type === "function_declaration" || node.type === "method_definition") {
      const caller = getCallableQualifiedName(node);
      const parameters = node.childForFieldName("parameters");
      if (caller && parameters) for (const parameter of parameters.namedChildren) {
        const { localName, typeName } = extractParameterType(parameter);
        if (localName && typeName) for (const binding of resolveClassBindings(typeName, filePath, imports)) {
          results.push({ callerQualifiedName: caller, localName, ...binding });
        }
      }
    }
    for (const child of node.namedChildren) walk(child);
  }
  walk(parser.parse(source).rootNode);
  return results;
}

function extractClassFieldBindings(source: string, filePath: string, importBindings: ImportBinding[]): ClassFieldBinding[] {
  const parser = createParser(filePath);
  if (!parser) return [];
  const imports = bindingsByLocalName(importBindings);
  const results: ClassFieldBinding[] = [];
  function add(owner: string | undefined, field: string | undefined, parameter: Parser.SyntaxNode): void {
    const { typeName } = extractParameterType(parameter);
    if (!owner || !field || !typeName) return;
    for (const binding of resolveClassBindings(typeName, filePath, imports)) results.push({ ownerClassName: owner, fieldName: field, ...binding });
  }
  function walk(node: Parser.SyntaxNode): void {
    if (node.type === "method_definition" && node.childForFieldName("name")?.text === "constructor") {
      const owner = findContainingClassName(node);
      for (const parameter of node.childForFieldName("parameters")?.namedChildren ?? []) {
        if (parameter.namedChildren.some((child) => child.type === "accessibility_modifier")) {
          add(owner, extractParameterType(parameter).localName, parameter);
        }
      }
    }
    if (node.type === "public_field_definition") {
      const owner = findContainingClassName(node);
      const name = node.childForFieldName("name");
      const type = node.childForFieldName("type")?.text.replace(/^:\s*/, "").trim();
      if (owner && name?.type === "property_identifier" && type && /^[A-Za-z_$][\w$]*$/.test(type)) {
        for (const binding of resolveClassBindings(type, filePath, imports)) results.push({ ownerClassName: owner, fieldName: name.text, ...binding });
      }
    }
    for (const child of node.namedChildren) walk(child);
  }
  walk(parser.parse(source).rootNode);
  return results;
}

function findCallerNodes(graph: CodeGraph, file: string, call: CallReference): GraphNode[] {
  if (!call.callerName || !call.callerType) return [];
  const qualified = call.callerQualifiedName
    ? graph.nodes.filter((node) => node.file === file && node.type === call.callerType && node.qualifiedName === call.callerQualifiedName)
    : [];
  return [...(qualified.length > 0 ? qualified : graph.nodes.filter((node) => node.file === file && node.name === call.callerName && node.type === call.callerType))]
    .sort((left, right) => left.id.localeCompare(right.id));
}

function findMethodNodes(graph: CodeGraph, targetFile: string, className: string, methodName: string): GraphNode[] {
  const qualifiedName = `${className}.${methodName}`;
  return graph.nodes.filter((node) => node.file === targetFile && node.type === "method" && node.qualifiedName === qualifiedName)
    .sort((left, right) => left.id.localeCompare(right.id));
}

function evidence(file: string, line: number, method?: ResolutionEvidence["resolutionMethod"]): ResolutionEvidence {
  return { evidenceKind: method ? "INFERRED" : "EXTRACTED", resolutionMethod: method, source: { file, line } };
}

function unresolved(file: string, line: number, reason: string, unsupportedDynamic = false): ResolutionResult {
  return { kind: "unresolved", evidence: [evidence(file, line)], reason, source: { file, line }, unsupportedDynamic };
}

function edgeFor(caller: GraphNode, callee: GraphNode, result: Extract<ResolutionResult, { kind: "resolved" }>): GraphEdge {
  return { from: caller.id, to: callee.id, type: "calls", resolutionMethod: result.resolutionMethod, evidenceKind: result.evidence[0]?.evidenceKind, confidence: result.confidence, resolutionSource: result.source };
}

export function resolveMemberCallResults(
  graph: CodeGraph,
  file: string,
  source: string,
  calls: CallReference[],
  importBindings: ImportBinding[],
  factEvidence?: MemberResolutionFactEvidence,
): ResolutionBatch {
  const coverage = emptyResolutionCoverage();
  const edges: GraphEdge[] = [];
  const results: ResolutionResult[] = [];
  const imports = bindingsByLocalName(importBindings);
  const objects = new Map<string, ObjectBinding[]>();
  const objectBindings = factEvidence
    ? extractFactsObjectBindings(source, file, importBindings)
    : extractObjectBindings(source, file, importBindings);
  for (const binding of objectBindings) objects.set(binding.localName, [...(objects.get(binding.localName) ?? []), binding]);
  const parameters = new Map<string, ParameterBinding[]>();
  const parameterBindings = factEvidence
    ? extractFactsParameterBindings(source, file, importBindings, calls)
    : extractParameterBindings(source, file, importBindings);
  for (const binding of parameterBindings) {
    const key = [binding.callerQualifiedName, binding.localName].join(":");
    parameters.set(key, [...(parameters.get(key) ?? []), binding]);
  }
  const fields = new Map<string, ClassFieldBinding[]>();
  const classFieldBindings = factEvidence
    ? extractFactsClassFieldBindings(source, file, importBindings)
    : extractClassFieldBindings(source, file, importBindings);
  for (const binding of classFieldBindings) {
    const key = [binding.ownerClassName, binding.fieldName].join(":");
    fields.set(key, [...(fields.get(key) ?? []), binding]);
  }
  const seen = new Set<string>();

  for (const call of calls) {
    if (!call.calleeName.includes(".")) continue;
    coverage.calls += 1;
    const callers = findCallerNodes(graph, file, call);
    const memberPath = parseMemberCallPath(call.calleeName);
    let result: ResolutionResult;
    if (callers.length !== 1) {
      result = callers.length > 1
        ? { kind: "ambiguous", candidates: callers.map((node) => node.id), evidence: [{ ...evidence(file, call.line), evidenceKind: "AMBIGUOUS" }], ambiguityReason: "caller identity is not unique", source: { file, line: call.line } }
        : unresolved(file, call.line, "caller identity is unavailable");
    } else if (!memberPath) {
      result = unresolved(file, call.line, "unsupported member expression", true);
    } else {
      const caller = callers[0]!;
      let bindings: Array<{ className: string; targetFile?: string }> = [];
      let method: ResolutionEvidence["resolutionMethod"];
      const methodName = memberPath.members.at(-1);
      if (memberPath.constructedClassName) {
        bindings = resolveClassBindings(memberPath.constructedClassName, file, imports);
        method = "constructor_type";
      } else if (memberPath.root === "this" && memberPath.members.length === 1 && call.callerClassName && methodName) {
        bindings = [{ className: call.callerClassName, targetFile: file }];
        method = "this_receiver";
      } else if (memberPath.root === "this" && memberPath.members.length === 2 && call.callerClassName) {
        const fieldName = memberPath.members[0];
        bindings = fieldName ? (fields.get([call.callerClassName, fieldName].join(":")) ?? []) : [];
        method = "field_type";
      } else if (memberPath.members.length === 1 && methodName && call.callerQualifiedName) {
        bindings = parameters.get([call.callerQualifiedName, memberPath.root].join(":")) ?? objects.get(memberPath.root) ?? [];
        method = parameters.has([call.callerQualifiedName, memberPath.root].join(":")) ? "parameter_type" : "constructor_type";
      } else {
        method = undefined;
      }
      const candidateNodes = methodName
        ? bindings.flatMap((binding) => binding.targetFile ? findMethodNodes(graph, binding.targetFile, binding.className, methodName) : [])
        : [];
      const candidates = candidateNodes.filter((node, index, all) => all.findIndex((item) => item.id === node.id) === index).sort((left, right) => left.id.localeCompare(right.id));
      if (candidates.length === 1 && candidates[0] && method) {
        result = { kind: "resolved", targetSymbolId: candidates[0].id, candidateCount: candidates.length, evidence: [evidence(file, call.line, method)], resolutionMethod: method, confidence: 1, source: { file, line: call.line } };
        if (caller.id !== candidates[0].id) {
          const edge = edgeFor(caller, candidates[0], result);
          const key = [edge.from, edge.to, edge.type].join(":");
          if (!seen.has(key)) { seen.add(key); edges.push(edge); }
        }
      } else if (candidates.length > 1) {
        result = { kind: "ambiguous", candidates: candidates.map((node) => node.id), evidence: [{ ...evidence(file, call.line), evidenceKind: "AMBIGUOUS" }], ambiguityReason: "member target is not unique", source: { file, line: call.line } };
      } else {
        result = unresolved(file, call.line, method ? "no unique member target candidate" : "unsupported receiver expression", !method || memberPath.members.length !== 1);
      }
    }
    if (result.kind === "resolved") coverage.resolvedCalls += 1;
    else if (result.kind === "ambiguous") coverage.ambiguousCalls += 1;
    else { coverage.unresolvedCalls += 1; if (result.unsupportedDynamic) coverage.unsupportedDynamic += 1; }
    results.push(result);
  }
  return { edges, results, coverage };
}

export function resolveMemberCallEdges(
  graph: CodeGraph,
  file: string,
  source: string,
  calls: CallReference[],
  importBindings: ImportBinding[],
): GraphEdge[] {
  return resolveMemberCallResults(graph, file, source, calls, importBindings).edges;
}
