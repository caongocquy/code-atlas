import type Parser from "tree-sitter";

import { parseSource, type ParsedSource } from "../../graph/parsers/code-parser.js";
import type {
  AssignmentFact, BindingSeedFact, CallSiteFact, ConstructorFact, ContainmentScopeFact,
  DeclaredTypeAnnotationFact, ExpressionFact, FactLocalId, ImportFact, ImplementationFact,
  MemberFact, ModuleFact, ParameterFact, ParsedFactsBlob, ParsedSymbolFact, ReferenceFact,
  ReturnFact, SourceRangeFact,
} from "../facts.types.js";
import type { FactExtractionOutcome } from "../facts-extractor.js";
import type { LanguageFactExtractor, LanguageFactExtractorInput } from "../language-fact-extractor.js";

const range = (node: Parser.SyntaxNode): SourceRangeFact => ({
  startLine: node.startPosition.row + 1,
  endLine: node.endPosition.row + 1,
  startColumn: node.startPosition.column,
  endColumn: node.endPosition.column,
});
const field = (node: Parser.SyntaxNode | undefined, name: string) => node?.childForFieldName(name);
const text = (node: Parser.SyntaxNode | null | undefined): string | undefined => node?.text;
const id = (kind: string, value: number) => `${kind}:${value}` as FactLocalId;

function nodeDiagnostics(root: Parser.SyntaxNode): string[] {
  const diagnostics: string[] = [];
  const visit = (node: Parser.SyntaxNode): void => {
    if (node.type === "ERROR" || node.isMissing) diagnostics.push(`${node.type}@${node.startPosition.row + 1}:${node.startPosition.column}`);
    for (const child of node.children) visit(child);
  };
  visit(root);
  return [...new Set(diagnostics)];
}

export function extractSwiftFacts(input: LanguageFactExtractorInput): FactExtractionOutcome {
  if (input.language !== "swift") return { kind: "infrastructure_failure", error: new Error(`Extractor swift received ${input.language} input`) };
  return extractSwiftTreeFacts(parseSource(input.source, input.filePath, "swift"), input);
}

function extractSwiftTreeFacts(parsed: ParsedSource | undefined, input: LanguageFactExtractorInput): FactExtractionOutcome {
  try {
    if (!parsed) return { kind: "infrastructure_failure", error: new Error("Unable to parse swift source") };
    const symbols: ParsedSymbolFact[] = [];
    const scopes: ContainmentScopeFact[] = [];
    const imports: ImportFact[] = [];
    const references: ReferenceFact[] = [];
    const calls: CallSiteFact[] = [];
    const bindings: BindingSeedFact[] = [];
    const types: DeclaredTypeAnnotationFact[] = [];
    const expressions: ExpressionFact[] = [];
    const members: MemberFact[] = [];
    const assignments: AssignmentFact[] = [];
    const parameters: ParameterFact[] = [];
    const returns: ReturnFact[] = [];
    const constructors: ConstructorFact[] = [];
    const implementations: ImplementationFact[] = [];
    const modules: ModuleFact[] = [];
    const scopeStack: FactLocalId[] = [];
    const typeStack: ParsedSymbolFact[] = [];
    const callableStack: ParsedSymbolFact[] = [];
    const symbolByName = new Map<string, ParsedSymbolFact[]>();
    const extensionOwners = new Set<FactLocalId>();
    let sequence = 0;
    const next = (kind: string) => id(kind, ++sequence);
    const addSymbol = (node: Parser.SyntaxNode, name: string, kind: ParsedSymbolFact["kind"], qualifiedName = name): ParsedSymbolFact => {
      const value = { localId: next("symbol"), name, kind, scopeId: scopeStack.at(-1), range: range(node), declaredQualifiedName: qualifiedName };
      symbols.push(value);
      symbolByName.set(name, [...(symbolByName.get(name) ?? []), value]);
      return value;
    };
    const addExpression = (node: Parser.SyntaxNode, kind: ExpressionFact["kind"]): ExpressionFact => {
      const value = { localId: next("expression"), kind, text: node.text, ownerScopeId: scopeStack.at(-1), range: range(node) };
      expressions.push(value);
      return value;
    };
    const addBinding = (node: Parser.SyntaxNode, name: string, bindingKind: string): BindingSeedFact => {
      const value = { localId: next("binding"), name, bindingKind, ownerId: scopeStack.at(-1), range: range(node) };
      bindings.push(value);
      return value;
    };
    const currentType = () => typeStack.at(-1);
    const visit = (node: Parser.SyntaxNode): void => {
      const typeNode = field(node, "name");
      const isProtocol = node.type === "protocol_declaration";
      const isType = (node.type === "class_declaration" || isProtocol) && ["type_identifier", "user_type"].includes(typeNode?.type ?? "");
      const isExtension = node.type === "class_declaration" && typeNode?.type === "user_type";
      const isCallable = ["function_declaration", "protocol_function_declaration", "init_declaration"].includes(node.type);
      const isScope = node.type === "source_file" || isType || isCallable || node.type === "function_body";
      if (isScope) {
        const scopeKind = node.type === "class_declaration" && node.children.some((child) => child.type === "struct") ? "struct_declaration" : node.type;
        const scope = { localId: next("scope"), kind: scopeKind, name: text(typeNode), parentId: scopeStack.at(-1), range: range(node) };
        scopes.push(scope);
        scopeStack.push(scope.localId);
      }

      let declared: ParsedSymbolFact | undefined;
      let extensionOwned = false;
      if (node.type === "import_declaration") {
        const imported = node.namedChildren.find((child) => child.type === "identifier");
        const module = imported?.namedChildren.map((child) => child.text).join(".") || imported?.text?.split(".")[0];
        if (module) imports.push({ localId: next("import"), moduleSpecifier: module, importedName: imported?.text, kind: "import", range: range(node) });
      } else if (isType && typeNode) {
        const name = typeNode.text.split(".").at(-1);
        if (name) {
          if (isExtension) {
            const owners = symbolByName.get(name)?.filter((item) => ["class", "interface", "enum"].includes(item.kind)) ?? [];
            const owner = owners.length === 1 ? owners[0] : undefined;
            if (owner) {
              typeStack.push(owner);
              extensionOwned = true;
              extensionOwners.add(owner.localId);
              implementations.push({ localId: next("implementation"), subjectId: owner.localId, targetName: name, relationKind: "extension", range: range(node) });
            }
            const inherited = node.namedChildren.find((child) => child.type === "inheritance_specifier")?.childForFieldName("inherits_from")?.text;
            if (owner && inherited) implementations.push({ localId: next("implementation"), subjectId: owner.localId, targetName: inherited, relationKind: "protocol_conformance", range: range(node) });
          } else {
            const kind = isProtocol ? "interface" : field(node, "body")?.type === "enum_class_body" ? "enum" : "class";
            declared = addSymbol(node, name, kind);
            typeStack.push(declared);
            const inherited = node.namedChildren.find((child) => child.type === "inheritance_specifier")?.childForFieldName("inherits_from")?.text;
            if (inherited) implementations.push({ localId: next("implementation"), subjectId: declared.localId, targetName: inherited, relationKind: kind === "interface" ? "interface" : "protocol_conformance", range: range(node) });
          }
        }
      } else if (node.type === "function_declaration" || node.type === "protocol_function_declaration") {
        const name = text(field(node, "name"));
        if (name) {
          const owner = currentType();
          declared = addSymbol(node, name, owner ? "method" : "function", owner ? `${owner.name}.${name}` : name);
          callableStack.push(declared);
          if (owner) members.push({ localId: next("member"), ownerSymbolId: owner.localId, memberName: name, memberKind: "method", access: extensionOwners.has(owner.localId) ? "extension" : "instance", range: range(node) });
          const returnType = field(node, "return_type");
          if (returnType) returns.push({ localId: next("return"), ownerSymbolId: declared.localId, typeText: returnType.text, range: range(returnType) });
        }
      } else if (node.type === "init_declaration") {
        const owner = currentType();
        if (owner) {
          declared = addSymbol(node, "init", "method", `${owner.name}.init`);
          callableStack.push(declared);
          constructors.push({ localId: next("constructor"), ownerSymbolId: declared.localId, constructedTypeName: owner.name, range: range(node) });
        }
      } else if (node.type === "parameter" && callableStack.at(-1)) {
        const name = text(field(node, "name"));
        const type = node.namedChildren.find((child) => child.type === "user_type" || child.type === "optional_type");
        if (name) {
          const binding = addBinding(node, name, "parameter");
          parameters.push({ localId: next("parameter"), ownerSymbolId: callableStack.at(-1)!.localId, name, bindingId: binding.localId, typeText: type?.text, index: parameters.filter((item) => item.ownerSymbolId === callableStack.at(-1)!.localId).length, range: range(node) });
          if (type) types.push({ localId: next("type"), ownerId: binding.localId, text: type.text, range: range(type) });
        }
      } else if (node.type === "property_declaration") {
        const name = field(node, "name")?.text;
        const owner = currentType();
        if (name && owner && !callableStack.at(-1)) {
          const member = addSymbol(node, name, "variable", `${owner.name}.${name}`);
          members.push({ localId: next("member"), ownerSymbolId: owner.localId, memberName: name, memberKind: field(node, "computed_value") ? "property" : "field", access: extensionOwners.has(owner.localId) ? "extension" : "instance", range: range(node) });
          const annotation = field(node, "type_annotation")?.childForFieldName("name");
          if (annotation) types.push({ localId: next("type"), ownerId: member.localId, text: annotation.text, range: range(annotation) });
        } else if (name && callableStack.at(-1)) {
          const binding = addBinding(node, name, "local");
          const value = field(node, "computed_value") ?? node.namedChildren.find((child) => child.type === "call_expression");
          const expression = value ? addExpression(value, value.type === "call_expression" ? "call" : "other") : undefined;
          assignments.push({ localId: next("assignment"), targetId: binding.localId, sourceExpressionId: expression?.localId, assignmentKind: "declaration", range: range(node) });
          if (value?.type === "call_expression") {
            const constructed = value.namedChildren.find((child) => child.type === "simple_identifier")?.text;
            if (constructed) constructors.push({ localId: next("constructor"), constructedTypeName: constructed, callExpressionId: expression?.localId, resultBindingId: binding.localId, range: range(value) });
          }
        }
      } else if (node.type === "call_expression") {
        const callee = node.namedChildren[0];
        if (callee) {
          const callId = next("call");
          calls.push({ localId: callId, calleeText: callee.text, callerId: callableStack.at(-1)?.localId, scopeId: scopeStack.at(-1), range: range(node) });
          if (callee.type === "navigation_expression") {
            const receiver = field(callee, "target") ?? callee.namedChildren[0];
            const suffix = callee.namedChildren.at(-1);
            const memberName = suffix?.namedChildren.at(-1)?.text ?? suffix?.text;
            if (receiver && memberName) members.push({ localId: callId, receiverId: addExpression(receiver, "identifier").localId, memberName, memberKind: "method", access: "instance", range: range(callee) });
          }
        }
      } else if (node.type === "assignment") {
        const target = node.childForFieldName("target");
        if (target) assignments.push({ localId: next("assignment"), targetId: next("binding"), sourceName: node.childForFieldName("result")?.text, assignmentKind: "reassignment", range: range(node) });
      } else if (node.type === "simple_identifier" && node.parent?.type !== "import_declaration") {
        references.push({ localId: next("reference"), name: node.text, ownerId: callableStack.at(-1)?.localId, scopeId: scopeStack.at(-1), range: range(node) });
      }

      for (const child of node.namedChildren) visit(child);
      if (isCallable && declared) callableStack.pop();
      if (isType && (declared || extensionOwned) && typeStack.length) typeStack.pop();
      if (isScope) scopeStack.pop();
    };
    visit(parsed.tree.rootNode);
    modules.push({ localId: next("module"), name: input.filePath, moduleKind: "file", exported: false, range: range(parsed.tree.rootNode) });
    const diagnostics = nodeDiagnostics(parsed.tree.rootNode);
    return { kind: "facts", facts: {
      factsSchemaVersion: input.factsSchemaVersion, factsVersion: input.factsVersion, contentHash: input.contentHash, language: "swift",
      parserIdentity: { language: parsed.adapter.language, ...parsed.adapter.metadata }, parseStatus: diagnostics.length ? "deterministic_partial" : "complete", parserDiagnostics: diagnostics,
      symbols, containmentScopes: scopes, imports, exports: [], references, callSites: calls, bindingSeeds: bindings, declaredTypeAnnotations: types,
      expressions, members, assignments, parameters, returns, constructors, inheritances: [], implementations, aliases: [], modules, namespaces: [],
    } };
  } catch (error) {
    return { kind: "infrastructure_failure", error: error instanceof Error ? error : new Error(String(error)) };
  }
}

export const swiftFactExtractor: LanguageFactExtractor = { language: "swift", extract: extractSwiftFacts };
