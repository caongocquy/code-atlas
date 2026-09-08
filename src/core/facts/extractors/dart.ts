import type Parser from "tree-sitter";

import { parseSource, type ParsedSource } from "../../graph/parsers/code-parser.js";
import type {
  AssignmentFact, BindingSeedFact, CallSiteFact, ConstructorFact, ContainmentScopeFact, DeclaredTypeAnnotationFact,
  ExpressionFact, FactLocalId, ImportFact, ImplementationFact, InheritanceFact, MemberFact, ModuleFact,
  ParameterFact, ParsedFactsBlob, ParsedSymbolFact, ReferenceFact, ReturnFact, SourceRangeFact,
} from "../facts.types.js";
import type { FactExtractionOutcome } from "../facts-extractor.js";
import type { LanguageFactExtractor, LanguageFactExtractorInput } from "../language-fact-extractor.js";

const range = (node: Parser.SyntaxNode): SourceRangeFact => ({ startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, startColumn: node.startPosition.column, endColumn: node.endPosition.column });
const field = (node: Parser.SyntaxNode | null | undefined, name: string) => node?.childForFieldName(name) ?? undefined;
const id = (kind: string, value: number) => `${kind}:${value}` as FactLocalId;
const nameOf = (node: Parser.SyntaxNode | null | undefined): string | undefined => node?.text?.split(".").at(-1);
const stripQuotes = (value: string): string => value.length >= 2 && ((value.startsWith("'") && value.endsWith("'")) || (value.startsWith('"') && value.endsWith('"'))) ? value.slice(1, -1) : value;

function diagnostics(root: Parser.SyntaxNode): string[] {
  const values: string[] = [];
  const visit = (node: Parser.SyntaxNode): void => { if (node.type === "ERROR" || node.isMissing) values.push(`${node.type}@${node.startPosition.row + 1}:${node.startPosition.column}`); for (const child of node.children) visit(child); };
  visit(root);
  return [...new Set(values)];
}

export function extractDartFacts(input: LanguageFactExtractorInput): FactExtractionOutcome {
  if (input.language !== "dart") return { kind: "infrastructure_failure", error: new Error(`Extractor dart received ${input.language} input`) };
  return extractDartTreeFacts(parseSource(input.source, input.filePath, "dart"), input);
}

function extractDartTreeFacts(parsed: ParsedSource | undefined, input: LanguageFactExtractorInput): FactExtractionOutcome {
  try {
    if (!parsed) return { kind: "infrastructure_failure", error: new Error("Unable to parse dart source") };
    const symbols: ParsedSymbolFact[] = [], scopes: ContainmentScopeFact[] = [], imports: ImportFact[] = [], references: ReferenceFact[] = [], calls: CallSiteFact[] = [];
    const bindings: BindingSeedFact[] = [], types: DeclaredTypeAnnotationFact[] = [], expressions: ExpressionFact[] = [], members: MemberFact[] = [], assignments: AssignmentFact[] = [];
    const parameters: ParameterFact[] = [], returns: ReturnFact[] = [], constructors: ConstructorFact[] = [], inheritances: InheritanceFact[] = [], implementations: ImplementationFact[] = [], modules: ModuleFact[] = [];
    const scopeStack: FactLocalId[] = [], typeStack: ParsedSymbolFact[] = [], callableStack: ParsedSymbolFact[] = [];
    const symbolsByName = new Map<string, ParsedSymbolFact[]>();
    const extensionNodes: Array<{ node: Parser.SyntaxNode; ownerName: string; extensionSymbol: ParsedSymbolFact; scopePath: FactLocalId[] }> = [];
    let extensionContext: { symbol: ParsedSymbolFact } | undefined;
    let sequence = 0;
    const next = (kind: string) => id(kind, ++sequence);
    const addSymbol = (node: Parser.SyntaxNode, name: string, kind: ParsedSymbolFact["kind"], qualifiedName = name): ParsedSymbolFact => {
      const value = { localId: next("symbol"), name, kind, scopeId: scopeStack.at(-1), declaredQualifiedName: qualifiedName, range: range(node) };
      symbols.push(value); symbolsByName.set(name, [...(symbolsByName.get(name) ?? []), value]); return value;
    };
    const addExpression = (node: Parser.SyntaxNode, kind: ExpressionFact["kind"]): ExpressionFact => { const value = { localId: next("expression"), kind, text: node.text, ownerScopeId: scopeStack.at(-1), range: range(node) }; expressions.push(value); return value; };
    const addBinding = (node: Parser.SyntaxNode, name: string, bindingKind: string): BindingSeedFact => { const value = { localId: next("binding"), name, bindingKind, ownerId: scopeStack.at(-1), range: range(node) }; bindings.push(value); return value; };
    const currentType = () => typeStack.at(-1);
    const visit = (node: Parser.SyntaxNode): void => {
      const isType = ["class_definition", "mixin_declaration"].includes(node.type);
      const isExtension = node.type === "extension_declaration";
      const isCallable = ["function_signature", "constructor_signature"].includes(node.type) && Boolean(field(node, "name"));
      const isScope = node.type === "program" || isType || isCallable || node.type === "function_body" || node.type === "class_body" || node.type === "extension_body";
      if (isExtension) {
        const ownerName = nameOf(field(node, "class"));
        const extensionName = nameOf(field(node, "name"));
        if (ownerName && extensionName) {
          const extensionSymbol = addSymbol(node, extensionName, "type", `extension:${extensionName}`);
          extensionNodes.push({ node, ownerName, extensionSymbol, scopePath: [...scopeStack] });
        }
        return;
      }
      if (isScope) { const scope = { localId: next("scope"), kind: node.type, name: nameOf(field(node, "name")), parentId: scopeStack.at(-1), range: range(node) }; scopes.push(scope); scopeStack.push(scope.localId); }
      let declared: ParsedSymbolFact | undefined;
      if (node.type === "import_or_export") {
        const uri = node.descendantsOfType("string_literal")[0]?.text;
        const moduleSpecifier = uri ? stripQuotes(uri) : undefined;
        if (moduleSpecifier) imports.push({ localId: next("import"), moduleSpecifier, localName: nameOf(node.namedChildren.at(-1)), kind: "import", range: range(node) });
      } else if (isType) {
        const name = nameOf(field(node, "name")) ?? nameOf(node.namedChildren.find((child) => child.type === "identifier"));
        if (name) { declared = addSymbol(node, name, "class"); typeStack.push(declared); }
        const superclass = field(node, "superclass")?.namedChildren.find((child) => child.type === "type_identifier")?.text;
        if (declared && superclass) inheritances.push({ localId: next("inheritance"), subjectId: declared.localId, targetName: superclass, relationKind: "extends", range: range(node) });
        const mixins = field(node, "superclass")?.namedChildren.find((child) => child.type === "mixins");
        if (declared && mixins) for (const mixin of mixins.namedChildren) implementations.push({ localId: next("implementation"), subjectId: declared.localId, targetName: mixin.text, relationKind: "mixin", range: range(mixin) });
        const interfaces = field(node, "interfaces");
        if (declared && interfaces) for (const item of interfaces.namedChildren) implementations.push({ localId: next("implementation"), subjectId: declared.localId, targetName: item.text, relationKind: "implements", range: range(item) });
      } else if (node.type === "function_signature") {
        const name = nameOf(field(node, "name"));
        if (name) { const owner = extensionContext?.symbol ?? currentType(); declared = addSymbol(node, name, owner ? "method" : "function", owner ? `${owner.declaredQualifiedName}.${name}` : name); callableStack.push(declared); if (owner) members.push({ localId: next("member"), ownerSymbolId: owner.localId, memberName: name, memberKind: "method", access: extensionContext ? "extension" : "instance", range: range(node) }); const returnType = field(node, "return_type"); if (returnType) returns.push({ localId: next("return"), ownerSymbolId: declared.localId, typeText: returnType.text, range: range(returnType) }); }
      } else if (node.type === "constructor_signature") {
        const owner = currentType();
        if (owner) { declared = addSymbol(node, "new", "method", `${owner.name}.new`); callableStack.push(declared); constructors.push({ localId: next("constructor"), ownerSymbolId: declared.localId, constructedTypeName: owner.name, range: range(node) }); }
      } else if (node.type === "formal_parameter_list" && callableStack.at(-1)) {
        for (const parameter of node.descendantsOfType("formal_parameter")) { const name = nameOf(parameter.namedChildren.find((child) => child.type === "identifier")); if (!name) continue; const type = parameter.namedChildren.find((child) => ["type_identifier", "built_in_type"].includes(child.type)); const binding = addBinding(parameter, name, "parameter"); parameters.push({ localId: next("parameter"), ownerSymbolId: callableStack.at(-1)!.localId, name, bindingId: binding.localId, typeText: type?.text, index: parameters.filter((item) => item.ownerSymbolId === callableStack.at(-1)!.localId).length, range: range(parameter) }); if (type) types.push({ localId: next("type"), ownerId: binding.localId, text: type.text, range: range(type) }); }
      } else if (node.type === "declaration" && (currentType() || extensionContext) && !callableStack.at(-1)) {
        const owner = extensionContext?.symbol ?? currentType();
        const name = nameOf(node.descendantsOfType("initialized_identifier")[0]?.namedChildren.find((child) => child.type === "identifier"));
        if (name && owner) { const member = addSymbol(node, name, "variable", `${owner.declaredQualifiedName}.${name}`); members.push({ localId: next("member"), ownerSymbolId: owner.localId, memberName: name, memberKind: "field", access: extensionContext ? "extension" : "instance", range: range(node) }); const type = node.namedChildren.find((child) => child.type === "type_identifier"); if (type) types.push({ localId: next("type"), ownerId: member.localId, text: type.text, range: range(type) }); }
      } else if (node.type === "initialized_variable_definition") {
        const name = nameOf(field(node, "name"));
        if (name) { const binding = addBinding(node, name, "local"); const value = node.namedChildren.find((child) => child.type === "selector"); const constructorType = field(node, "value"); const expression = value ? addExpression(value, "call") : undefined; assignments.push({ localId: next("assignment"), targetId: binding.localId, sourceExpressionId: expression?.localId, assignmentKind: "declaration", range: range(node) }); if (constructorType) constructors.push({ localId: next("constructor"), constructedTypeName: constructorType.text, callExpressionId: expression?.localId, resultBindingId: binding.localId, range: range(value ?? node) }); const type = node.namedChildren.find((child) => child.type === "type_identifier"); if (type) types.push({ localId: next("type"), ownerId: binding.localId, text: type.text, range: range(type) }); }
      } else if (node.type === "local_variable_declaration") {
        const name = nameOf(node.namedChildren.find((child) => child.type === "identifier") ?? node.descendantsOfType("identifier").at(-1));
        if (name) bindings.push({ localId: next("binding"), name, bindingKind: "local", ownerId: scopeStack.at(-1), range: range(node) });
      } else if (node.type === "assignment_expression") {
        const target = node.childForFieldName("left");
        const receiver = target?.namedChildren.find((child) => child.type === "identifier");
        const selector = target?.namedChildren.find((child) => child.type === "unconditional_assignable_selector");
        const memberName = selector?.text?.startsWith(".") ? selector.text.slice(1) : selector?.text;
        if (target && receiver && memberName) {
          const existingMember = members.find((item) => item.memberName === memberName && item.ownerSymbolId && !item.receiverId);
          if (existingMember) assignments.push({ localId: next("assignment"), targetId: existingMember.localId, sourceName: node.childForFieldName("right")?.text, assignmentKind: "reassignment", range: range(node) });
        }
      } else if (node.type === "selector") {
        const selector = node.namedChildren.find((child) => ["unconditional_assignable_selector", "assignable_selector"].includes(child.type));
        const parent = node.parent?.type === "selector" || node.parent?.type === "expression_statement" ? node.parent : undefined;
        const receiver = parent?.namedChildren.find((child) => child.type === "identifier");
        const memberName = selector?.text?.replace(/^\./, "");
        if (receiver && memberName) members.push({ localId: next("member"), receiverId: addExpression(receiver, "identifier").localId, memberName, memberKind: "property", access: "instance", range: range(node) });
        if (node.namedChildren.some((child) => child.type === "argument_part") && receiver) calls.push({ localId: next("call"), calleeText: `${receiver.text}.${memberName ?? node.text}`, callerId: callableStack.at(-1)?.localId, scopeId: scopeStack.at(-1), range: range(node) });
      } else if (node.type === "identifier" && node.parent?.type !== "import_or_export") references.push({ localId: next("reference"), name: node.text, ownerId: callableStack.at(-1)?.localId, scopeId: scopeStack.at(-1), range: range(node) });
      for (const child of node.namedChildren) visit(child);
      if (isCallable && declared) callableStack.pop();
      if (isType && declared) typeStack.pop();
      if (isScope) scopeStack.pop();
    };
    visit(parsed.tree.rootNode);
    for (const extension of extensionNodes) {
      const owners = symbolsByName.get(extension.ownerName)?.filter((item) => item.kind === "class") ?? [];
      if (owners.length !== 1) continue;
      implementations.push({ localId: next("implementation"), subjectId: extension.extensionSymbol.localId, targetName: extension.ownerName, relationKind: "extension", range: range(extension.node) });
      scopeStack.push(...extension.scopePath); extensionContext = { symbol: extension.extensionSymbol }; for (const child of extension.node.namedChildren) if (child.type === "extension_body") visit(child); extensionContext = undefined; scopeStack.length -= extension.scopePath.length;
    }
    modules.push({ localId: next("module"), name: input.filePath, moduleKind: "file", exported: false, range: range(parsed.tree.rootNode) });
    const parserDiagnostics = diagnostics(parsed.tree.rootNode);
    return { kind: "facts", facts: { factsSchemaVersion: input.factsSchemaVersion, factsVersion: input.factsVersion, contentHash: input.contentHash, language: "dart", parserIdentity: { language: parsed.adapter.language, ...parsed.adapter.metadata }, parseStatus: parserDiagnostics.length ? "deterministic_partial" : "complete", parserDiagnostics, symbols, containmentScopes: scopes, imports, exports: [], references, callSites: calls, bindingSeeds: bindings, declaredTypeAnnotations: types, expressions, members, assignments, parameters, returns, constructors, inheritances, implementations, aliases: [], modules, namespaces: [] } };
  } catch (error) { return { kind: "infrastructure_failure", error: error instanceof Error ? error : new Error(String(error)) }; }
}

export const dartFactExtractor: LanguageFactExtractor = { language: "dart", extract: extractDartFacts };
