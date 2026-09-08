import type Parser from "tree-sitter";
import { parseSource, type ParsedSource } from "../../graph/parsers/code-parser.js";
import type { AliasFact, AssignmentFact, BindingSeedFact, CallSiteFact, ConstructorFact, ContainmentScopeFact, DeclaredTypeAnnotationFact, ExpressionFact, FactLocalId, ImportFact, ImplementationFact, InheritanceFact, MemberFact, ModuleFact, ParameterFact, ParsedFactsBlob, ParsedSymbolFact, ReferenceFact, ReturnFact, SourceRangeFact } from "../facts.types.js";
import type { FactExtractionOutcome } from "../facts-extractor.js";
import type { LanguageFactExtractor, LanguageFactExtractorInput } from "../language-fact-extractor.js";

const id = (kind: string, n: number) => `${kind}:${n}` as FactLocalId;
const range = (node: Parser.SyntaxNode): SourceRangeFact => ({ startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, startColumn: node.startPosition.column, endColumn: node.endPosition.column });
const field = (node: Parser.SyntaxNode | undefined, name: string) => node?.childForFieldName(name) ?? undefined;
const named = (node: Parser.SyntaxNode | undefined, types: readonly string[]) => node?.namedChildren.find((child) => types.includes(child.type));
const typeNode = (node: Parser.SyntaxNode | undefined) => node?.namedChildren.find((child) => ["user_type", "nullable_type", "type_identifier"].includes(child.type));

export function extractKotlinFacts(input: LanguageFactExtractorInput): FactExtractionOutcome {
  if (input.language !== "kotlin") return { kind: "infrastructure_failure", error: new Error(`Extractor kotlin received ${input.language} input`) };
  return extractKotlinTreeFacts(parseSource(input.source, input.filePath, "kotlin"), input);
}

function extractKotlinTreeFacts(parsed: ParsedSource | undefined, input: LanguageFactExtractorInput): FactExtractionOutcome {
  try {
    if (!parsed) return { kind: "infrastructure_failure", error: new Error("Unable to parse kotlin source") };
    const symbols: ParsedSymbolFact[] = [], containmentScopes: ContainmentScopeFact[] = [], imports: ImportFact[] = [], references: ReferenceFact[] = [], callSites: CallSiteFact[] = [];
    const bindingSeeds: BindingSeedFact[] = [], declaredTypeAnnotations: DeclaredTypeAnnotationFact[] = [], expressions: ExpressionFact[] = [], members: MemberFact[] = [], assignments: AssignmentFact[] = [];
    const parameters: ParameterFact[] = [], returns: ReturnFact[] = [], constructors: ConstructorFact[] = [], inheritances: InheritanceFact[] = [], implementations: ImplementationFact[] = [], aliases: AliasFact[] = [], modules: ModuleFact[] = [];
    const scopeStack: FactLocalId[] = [], typeStack: ParsedSymbolFact[] = [], callableStack: ParsedSymbolFact[] = [];
    let sequence = 0; const next = (kind: string) => id(kind, ++sequence);
    const symbol = (node: Parser.SyntaxNode, kind: ParsedSymbolFact["kind"], name: string): ParsedSymbolFact => { const value = { localId: next("symbol"), name, kind, range: range(node), scopeId: scopeStack.at(-1), declaredQualifiedName: name }; symbols.push(value); return value; };
    const expression = (node: Parser.SyntaxNode, kind: ExpressionFact["kind"]): ExpressionFact => { const value = { localId: next("expression"), kind, text: node.text, ownerScopeId: scopeStack.at(-1), range: range(node) }; expressions.push(value); return value; };
    const bind = (node: Parser.SyntaxNode, name: string, bindingKind: string, ownerId = scopeStack.at(-1)): BindingSeedFact => { const value = { localId: next("binding"), name, bindingKind, ownerId, range: range(node) }; bindingSeeds.push(value); return value; };
    const addType = (ownerId: FactLocalId, node: Parser.SyntaxNode | undefined): void => { if (node) declaredTypeAnnotations.push({ localId: next("type"), ownerId, text: node.text, range: range(node) }); };
    const visit = (node: Parser.SyntaxNode): void => {
      const isType = ["class_declaration", "object_declaration"].includes(node.type);
      const isFunction = node.type === "function_declaration";
      const isScope = node.type === "source_file" || isType || isFunction || node.type === "class_body" || node.type === "function_body";
      if (isScope) { const scope = { localId: next("scope"), kind: node.type, name: node.type === "companion_object" ? "Companion" : node.namedChildren[0]?.text, parentId: scopeStack.at(-1), range: range(node) }; containmentScopes.push(scope); scopeStack.push(scope.localId); }
      let declared: ParsedSymbolFact | undefined;
      if (node.type === "package_header") { const value = named(node, ["identifier"]); if (value) modules.push({ localId: next("module"), name: value.text, moduleKind: "package", exported: true, range: range(node) }); }
      if (node.type === "import_header") { const value = named(node, ["identifier"]); if (value) imports.push({ localId: next("import"), moduleSpecifier: value.text, importedName: value.text.split(".").at(-1), localName: value.text.split(".").at(-1), kind: "named", range: range(node) }); }
      if (node.type === "type_alias") { const name = node.namedChildren[0], target = node.namedChildren[1]; if (name && target) { declared = symbol(node, "type", name.text); aliases.push({ localId: next("alias"), aliasName: name.text, targetName: target.text, aliasKind: "type", range: range(node) }); } }
      if (isType) { const name = node.namedChildren.find((child) => child.type === "type_identifier")?.text; if (name) { declared = symbol(node, node.text.startsWith("interface ") ? "interface" : "class", name); typeStack.push(declared); if (node.type === "object_declaration") declared.name = name; const primary = node.namedChildren.find((child) => child.type === "primary_constructor"); if (node.type === "class_declaration" && primary) constructors.push({ localId: next("constructor"), ownerSymbolId: declared.localId, constructedTypeName: name, range: range(primary) }); } const specs = node.namedChildren.filter((child) => child.type === "delegation_specifier"); for (const spec of specs) { const target = spec.namedChildren.find((child) => ["user_type", "constructor_invocation"].includes(child.type)); const targetName = target?.namedChildren[0]?.text ?? target?.text; if (declared && target && targetName) (target.type === "user_type" ? implementations : inheritances).push({ localId: next(target.type === "user_type" ? "implementation" : "inheritance"), subjectId: declared.localId, targetName, relationKind: target.type === "user_type" ? "implements" : "extends", range: range(target) } as ImplementationFact & InheritanceFact); } }
      if (node.type === "companion_object") { const owner = typeStack.at(-1); if (owner) { const companion = symbol(node, "class", `${owner.name}.Companion`); companion.scopeId = scopeStack.at(-1); } }
      if (isFunction) { const nameNode = node.namedChildren.find((child) => child.type === "simple_identifier"); if (nameNode) { declared = symbol(node, "method", nameNode.text); callableStack.push(declared); const resultType = typeNode(node); addType(declared.localId, resultType); const receiver = node.namedChildren.find((child) => child.type === "user_type" && child !== resultType); if (receiver) implementations.push({ localId: next("implementation"), subjectId: declared.localId, targetName: receiver.text, relationKind: "extension", range: range(receiver) }); if (resultType) returns.push({ localId: next("return"), ownerSymbolId: declared.localId, typeText: resultType.text, range: range(resultType) }); } }
      if (node.type === "class_parameter") { const name = node.namedChildren.find((child) => child.type === "simple_identifier"), type = typeNode(node); const owner = typeStack.at(-1); if (name && owner) { const binding = bind(node, name.text, "field", owner.scopeId); const member = symbol(node, "variable", name.text); member.scopeId = owner.scopeId; addType(member.localId, type); parameters.push({ localId: next("parameter"), ownerSymbolId: owner.localId, name: name.text, bindingId: binding.localId, typeText: type?.text, index: parameters.filter((item) => item.ownerSymbolId === owner.localId).length, range: range(node) }); } }
      if (node.type === "function_declaration") { const parameterContainer = node.namedChildren.find((child) => child.type === "function_value_parameters"); const owner = callableStack.at(-1); for (const parameter of parameterContainer?.namedChildren ?? []) { const name = parameter.namedChildren.find((child) => child.type === "simple_identifier"); const type = typeNode(parameter); if (name && owner) { const binding = bind(parameter, name.text, "parameter"); parameters.push({ localId: next("parameter"), ownerSymbolId: owner.localId, name: name.text, bindingId: binding.localId, typeText: type?.text, index: parameters.filter((item) => item.ownerSymbolId === owner.localId).length, range: range(parameter) }); addType(binding.localId, type); } } }
      if (node.type === "call_expression") { const callee = node.namedChildren[0]; if (callee) { callSites.push({ localId: next("call"), calleeText: callee.text, callerId: callableStack.at(-1)?.localId, scopeId: scopeStack.at(-1), range: range(node) }); const className = symbols.find((item) => item.kind === "class" && item.name === callee.text); if (className) constructors.push({ localId: next("constructor"), ownerSymbolId: callableStack.at(-1)?.localId, constructedTypeName: callee.text, callExpressionId: expression(node, "construct").localId, range: range(node) }); } }
      if (node.type === "navigation_expression") { const receiver = node.namedChildren[0], memberName = node.namedChildren.at(-1); if (receiver && memberName && receiver !== memberName) { const value = expression(receiver, "member"); members.push({ localId: next("member"), receiverId: value.localId, memberName: memberName.text, memberKind: "method", access: "instance", range: range(node) }); } }
      if (node.type === "call_expression" && node.namedChildren[0]) { const callee = node.namedChildren[0]; if (callee.type === "simple_identifier") { const value = expression(callee, "identifier"); members.push({ localId: next("member"), receiverId: value.localId, memberName: callee.text, memberKind: "method", access: "instance", range: range(node) }); } }
      if (node.type === "return_expression") { const owner = callableStack.at(-1); if (owner) returns.push({ localId: next("return"), ownerSymbolId: owner.localId, expressionId: node.namedChildren[0] ? expression(node.namedChildren[0], "other").localId : undefined, typeText: declaredTypeAnnotations.find((item) => item.ownerId === owner.localId)?.text, range: range(node) }); }
      if (node.type === "simple_identifier" && node.parent?.type !== "function_declaration") references.push({ localId: next("reference"), name: node.text, scopeId: scopeStack.at(-1), range: range(node) });
      for (const child of node.namedChildren) visit(child);
      if (isFunction && declared) callableStack.pop();
      if (isType && declared) typeStack.pop();
      if (isScope) scopeStack.pop();
    };
    visit(parsed.tree.rootNode);
    const diagnostics: string[] = [], collect = (node: Parser.SyntaxNode): void => { if (node.type === "ERROR" || node.isMissing) diagnostics.push(`${node.type}@${node.startPosition.row + 1}:${node.startPosition.column}`); for (const child of node.children) collect(child); };
    collect(parsed.tree.rootNode);
    modules.push({ localId: next("module"), name: input.filePath, moduleKind: "file", exported: false, range: range(parsed.tree.rootNode) });
    const facts: ParsedFactsBlob = { factsSchemaVersion: input.factsSchemaVersion, factsVersion: input.factsVersion, contentHash: input.contentHash, language: "kotlin", parserIdentity: { language: parsed.adapter.language, ...parsed.adapter.metadata }, parseStatus: diagnostics.length ? "deterministic_partial" : "complete", parserDiagnostics: [...new Set(diagnostics)], symbols, containmentScopes, imports, exports: [], references, callSites, bindingSeeds, declaredTypeAnnotations, expressions, members, assignments, parameters, returns, constructors, inheritances, implementations, aliases, modules, namespaces: [] };
    return { kind: "facts", facts };
  } catch (error) { return { kind: "infrastructure_failure", error: error instanceof Error ? error : new Error(String(error)) }; }
}

export const kotlinFactExtractor: LanguageFactExtractor = { language: "kotlin", extract: extractKotlinFacts };
