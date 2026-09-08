import type Parser from "tree-sitter";

import { parseSource, type ParsedSource } from "../../graph/parsers/code-parser.js";
import type {
  AssignmentFact, BindingSeedFact, CallSiteFact, ConstructorFact, ContainmentScopeFact, DeclaredTypeAnnotationFact,
  ExpressionFact, FactLocalId, ImportFact, ImplementationFact, MemberFact, ModuleFact, ParameterFact,
  ParsedFactsBlob, ParsedSymbolFact, ReferenceFact, ReturnFact, SourceRangeFact,
} from "../facts.types.js";
import type { FactExtractionOutcome } from "../facts-extractor.js";
import type { LanguageFactExtractor, LanguageFactExtractorInput } from "../language-fact-extractor.js";

const range = (node: Parser.SyntaxNode): SourceRangeFact => ({ startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, startColumn: node.startPosition.column, endColumn: node.endPosition.column });
const field = (node: Parser.SyntaxNode | undefined, name: string) => node?.childForFieldName(name) ?? undefined;
const id = (kind: string, n: number) => `${kind}:${n}` as FactLocalId;
const typeName = (node: Parser.SyntaxNode | undefined): string | undefined => node?.text;

export function extractGoFacts(input: LanguageFactExtractorInput): FactExtractionOutcome {
  if (input.language !== "go") return { kind: "infrastructure_failure", error: new Error(`Extractor go received ${input.language} input`) };
  return extractGoTreeFacts(parseSource(input.source, input.filePath, "go"), input);
}

function extractGoTreeFacts(parsed: ParsedSource | undefined, input: LanguageFactExtractorInput): FactExtractionOutcome {
  try {
    if (!parsed) return { kind: "infrastructure_failure", error: new Error("Unable to parse go source") };
    const symbols: ParsedSymbolFact[] = [], scopes: ContainmentScopeFact[] = [], imports: ImportFact[] = [], references: ReferenceFact[] = [], calls: CallSiteFact[] = [];
    const bindings: BindingSeedFact[] = [], types: DeclaredTypeAnnotationFact[] = [], expressions: ExpressionFact[] = [], members: MemberFact[] = [], assignments: AssignmentFact[] = [];
    const parameters: ParameterFact[] = [], returns: ReturnFact[] = [], constructors: ConstructorFact[] = [], implementations: ImplementationFact[] = [], modules: ModuleFact[] = [];
    const scopeStack: FactLocalId[] = [], callableStack: ParsedSymbolFact[] = [], typeStack: ParsedSymbolFact[] = [];
    const receiverParameters = new WeakSet<Parser.SyntaxNode>();
    const receiverTypes = new Map<FactLocalId, string>();
    const selectorMembers = new WeakMap<Parser.SyntaxNode, MemberFact>();
    let packageName = "";
    let sequence = 0;
    const next = (kind: string) => id(kind, ++sequence);
    const symbol = (node: Parser.SyntaxNode, kind: ParsedSymbolFact["kind"], name: string, scopeId = scopeStack.at(-1), qualifiedName = packageName ? `${packageName}.${name}` : name): ParsedSymbolFact => {
      const value = { localId: next("symbol"), name, kind, range: range(node), scopeId, declaredQualifiedName: qualifiedName };
      symbols.push(value); return value;
    };
    const expression = (node: Parser.SyntaxNode, kind: ExpressionFact["kind"]): ExpressionFact => {
      const value = { localId: next("expression"), kind, text: node.text, ownerScopeId: scopeStack.at(-1), range: range(node) };
      expressions.push(value); return value;
    };
    const bind = (node: Parser.SyntaxNode, name: string, bindingKind: string, ownerId = scopeStack.at(-1)): BindingSeedFact => {
      const value = { localId: next("binding"), name, bindingKind, ownerId, range: range(node) };
      bindings.push(value); return value;
    };
    const visit = (node: Parser.SyntaxNode): void => {
      const isType = node.type === "type_spec";
      const isCallable = node.type === "function_declaration" || node.type === "method_declaration";
      const isScope = node.type === "source_file" || isType || isCallable || node.type === "block";
      if (isScope) scopes.push({ localId: next("scope"), kind: node.type, name: field(node, "name")?.text, parentId: scopeStack.at(-1), range: range(node) }), scopeStack.push(scopes.at(-1)!.localId);
      let declared: ParsedSymbolFact | undefined;
      let callLocalId: FactLocalId | undefined;
      if (node.type === "package_clause") {
        const name = node.namedChildren[0]; if (name) { packageName = name.text; modules.push({ localId: next("module"), name: name.text, moduleKind: "package", exported: true, range: range(node) }); }
      } else if (node.type === "import_spec") {
        const path = field(node, "path") ?? node.namedChildren[0]; if (path) imports.push({ localId: next("import"), moduleSpecifier: path.text.replaceAll('"', ""), localName: field(node, "name")?.text, kind: "package", range: range(node) });
      } else if (isType) {
        const name = field(node, "name")?.text;
        const typeNode = field(node, "type");
        if (name) { declared = symbol(node, typeNode?.type === "interface_type" ? "interface" : "class", name); typeStack.push(declared); }
      } else if (isCallable) {
        const name = field(node, "name")?.text;
        const receiver = field(node, "receiver");
        const receiverType = receiver?.namedChildren.find((item) => item.type === "parameter_declaration")?.childForFieldName("type")?.text?.replaceAll("*", "");
        if (name) { declared = symbol(node, receiver ? "method" : "function", name, scopeStack.at(-1), receiverType && packageName ? `${packageName}.${receiverType}.${name}` : undefined); callableStack.push(declared); if (receiverType) receiverTypes.set(declared.localId, receiverType); }
        if (receiver) for (const parameter of receiver.namedChildren.filter((item) => item.type === "parameter_declaration")) {
          const receiverName = field(parameter, "name")?.text ?? `__receiver_${typeName(field(parameter, "type")) ?? "unknown"}`;
          receiverParameters.add(parameter);
          if (receiverName) { const binding = bind(parameter, receiverName, "receiver"); parameters.push({ localId: next("parameter"), ownerSymbolId: declared!.localId, name: receiverName, bindingId: binding.localId, typeText: typeName(field(parameter, "type")), index: 0, receiverKind: "go_receiver", range: range(parameter) }); if (field(parameter, "type")) types.push({ localId: next("type"), ownerId: binding.localId, text: typeName(field(parameter, "type"))!, range: range(field(parameter, "type")!) }); }
        }
      } else if (node.type === "method_elem") {
        const name = field(node, "name")?.text; if (name && typeStack.at(-1)) { declared = symbol(node, "method", name, scopeStack.at(-1), packageName ? `${packageName}.${typeStack.at(-1)!.name}.${name}` : name); members.push({ localId: next("member"), ownerSymbolId: typeStack.at(-1)!.localId, memberName: name, memberKind: "method", access: "instance", range: range(node) }); }
      } else if (node.type === "field_declaration" && typeStack.at(-1)) {
        const name = field(node, "name")?.text; if (name) { const member = symbol(node, "variable", name, scopeStack.at(-1)); members.push({ localId: next("member"), ownerSymbolId: typeStack.at(-1)!.localId, memberName: name, memberKind: "field", access: "instance", range: range(node) }); if (field(node, "type")) types.push({ localId: next("type"), ownerId: member.localId, text: typeName(field(node, "type"))!, range: range(field(node, "type")!) }); }
      } else if (node.type === "parameter_declaration" && callableStack.at(-1) && !receiverParameters.has(node)) {
        const name = field(node, "name")?.text; if (name) { const binding = bind(node, name, "parameter"); parameters.push({ localId: next("parameter"), ownerSymbolId: callableStack.at(-1)!.localId, name, bindingId: binding.localId, typeText: typeName(field(node, "type")), index: parameters.filter((item) => item.ownerSymbolId === callableStack.at(-1)!.localId).length, range: range(node) }); if (field(node, "type")) types.push({ localId: next("type"), ownerId: binding.localId, text: typeName(field(node, "type"))!, range: range(field(node, "type")!) }); }
      } else if (node.type === "selector_expression") {
        const operand = field(node, "operand"), memberName = field(node, "field"); if (operand && memberName) { const member = { localId: next("member"), receiverId: expression(operand, operand.type === "selector_expression" ? "member" : "identifier").localId, memberName: memberName.text, memberKind: "method" as const, access: "instance" as const, range: range(node) }; members.push(member); selectorMembers.set(node, member); }
      } else if (node.type === "call_expression") {
        const fn = field(node, "function") ?? node.namedChildren[0]; if (fn) { callLocalId = next("call"); calls.push({ localId: callLocalId, calleeText: fn.text, callerId: callableStack.at(-1)?.localId, scopeId: scopeStack.at(-1), range: range(node) }); }
      } else if (node.type === "composite_literal") {
        const type = field(node, "type"); if (type) constructors.push({ localId: next("constructor"), ownerSymbolId: callableStack.at(-1)?.localId, constructedTypeName: type.text, range: range(node) });
      } else if (node.type === "return_statement" && callableStack.at(-1)) {
        returns.push({ localId: next("return"), ownerSymbolId: callableStack.at(-1)!.localId, expressionId: node.namedChildren[0] ? expression(node.namedChildren[0], "other").localId : undefined, range: range(node) });
      } else if (node.type === "identifier" && node.parent?.type !== "selector_expression") references.push({ localId: next("reference"), name: node.text, scopeId: scopeStack.at(-1), range: range(node) });
      for (const child of node.namedChildren) visit(child);
      if (callLocalId) { const fn = field(node, "function") ?? node.namedChildren[0]; const member = fn ? selectorMembers.get(fn) ?? members.find((item) => item.range.startLine === fn.startPosition.row + 1 && item.range.startColumn === fn.startPosition.column) : undefined; if (member) member.localId = callLocalId; }
      if (isCallable && declared) callableStack.pop();
      if (isType && declared) typeStack.pop();
      if (isScope) scopeStack.pop();
    };
    visit(parsed.tree.rootNode);
    const typeSymbols = symbols.filter((item) => item.kind === "class" || item.kind === "interface");
    const interfaces = symbols.filter((item) => item.kind === "interface");
    for (const concrete of symbols.filter((item) => item.kind === "method")) { const receiver = receiverTypes.get(concrete.localId); const owner = typeSymbols.find((item) => item.name === receiver); if (!receiver || !owner) continue; members.push({ localId: next("member"), ownerSymbolId: owner.localId, memberName: concrete.name, memberKind: "method", access: "instance", range: concrete.range }); for (const iface of interfaces) if (members.some((item) => item.ownerSymbolId === iface.localId && item.memberName === concrete.name)) implementations.push({ localId: next("implementation"), subjectId: owner.localId, targetName: iface.name, relationKind: "interface", range: concrete.range }); }
    const diagnostics: string[] = [], collect = (node: Parser.SyntaxNode): void => { if (node.type === "ERROR" || node.isMissing) diagnostics.push(`${node.type}@${node.startPosition.row + 1}:${node.startPosition.column}`); for (const child of node.children) collect(child); };
    collect(parsed.tree.rootNode);
    modules.push({ localId: next("module"), name: input.filePath, moduleKind: "file", exported: false, range: range(parsed.tree.rootNode) });
    return { kind: "facts", facts: { factsSchemaVersion: input.factsSchemaVersion, factsVersion: input.factsVersion, contentHash: input.contentHash, language: "go", parserIdentity: { language: parsed.adapter.language, ...parsed.adapter.metadata }, parseStatus: diagnostics.length ? "deterministic_partial" : "complete", parserDiagnostics: [...new Set(diagnostics)], symbols, containmentScopes: scopes, imports, exports: [], references, callSites: calls, bindingSeeds: bindings, declaredTypeAnnotations: types, expressions, members, assignments, parameters, returns, constructors, inheritances: [], implementations, aliases: [], modules, namespaces: [] } };
  } catch (error) { return { kind: "infrastructure_failure", error: error instanceof Error ? error : new Error(String(error)) }; }
}

export const goFactExtractor: LanguageFactExtractor = { language: "go", extract: extractGoFacts };
