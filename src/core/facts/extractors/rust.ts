import type Parser from "tree-sitter";

import { parseSource, type ParsedSource } from "../../graph/parsers/code-parser.js";
import type {
  AliasFact, AssignmentFact, BindingSeedFact, CallSiteFact, ConstructorFact, ContainmentScopeFact,
  DeclaredTypeAnnotationFact, ExpressionFact, FactLocalId, ImportFact, ImplementationFact, InheritanceFact,
  MemberFact, ModuleFact, ParameterFact, ParsedFactsBlob, ParsedSymbolFact, ReferenceFact, ReturnFact, SourceRangeFact,
} from "../facts.types.js";
import type { FactExtractionOutcome } from "../facts-extractor.js";
import type { LanguageFactExtractor, LanguageFactExtractorInput } from "../language-fact-extractor.js";

const range = (node: Parser.SyntaxNode): SourceRangeFact => ({ startLine: node.startPosition.row + 1, endLine: node.endPosition.row + 1, startColumn: node.startPosition.column, endColumn: node.endPosition.column });
const field = (node: Parser.SyntaxNode | undefined, name: string) => node?.childForFieldName(name);
const id = (kind: string, n: number) => `${kind}:${n}` as FactLocalId;
const text = (node: Parser.SyntaxNode | null | undefined): string | undefined => node?.text;
const unqualified = (value: string): string => {
  let normalized = value;
  if (normalized.startsWith("&")) normalized = normalized.slice(1).trimStart();
  if (normalized.startsWith("mut ")) normalized = normalized.slice(4);
  if (normalized.startsWith("*")) normalized = normalized.slice(1);
  return normalized.split("::").at(-1) ?? normalized;
};

export function extractRustFacts(input: LanguageFactExtractorInput): FactExtractionOutcome {
  if (input.language !== "rust") return { kind: "infrastructure_failure", error: new Error(`Extractor rust received ${input.language} input`) };
  return extractRustTreeFacts(parseSource(input.source, input.filePath, "rust"), input);
}

function extractRustTreeFacts(parsed: ParsedSource | undefined, input: LanguageFactExtractorInput): FactExtractionOutcome {
  try {
    if (!parsed) return { kind: "infrastructure_failure", error: new Error("Unable to parse rust source") };
    const symbols: ParsedSymbolFact[] = [], scopes: ContainmentScopeFact[] = [], imports: ImportFact[] = [], references: ReferenceFact[] = [];
    const calls: CallSiteFact[] = [], bindings: BindingSeedFact[] = [], types: DeclaredTypeAnnotationFact[] = [], expressions: ExpressionFact[] = [];
    const members: MemberFact[] = [], assignments: AssignmentFact[] = [], parameters: ParameterFact[] = [], returns: ReturnFact[] = [], constructors: ConstructorFact[] = [];
    const inheritances: InheritanceFact[] = [], implementations: ImplementationFact[] = [], aliases: AliasFact[] = [], modules: ModuleFact[] = [];
    const scopeStack: FactLocalId[] = [], callableStack: ParsedSymbolFact[] = [], typeStack: ParsedSymbolFact[] = [];
    const symbolByName = new Map<string, ParsedSymbolFact[]>();
    let sequence = 0;
    const next = (kind: string) => id(kind, ++sequence);
    const addSymbol = (node: Parser.SyntaxNode, kind: ParsedSymbolFact["kind"], name: string, qualifiedName = name): ParsedSymbolFact => {
      const value = { localId: next("symbol"), name, kind, range: range(node), scopeId: scopeStack.at(-1), declaredQualifiedName: qualifiedName };
      symbols.push(value); symbolByName.set(name, [...(symbolByName.get(name) ?? []), value]); return value;
    };
    const addExpression = (node: Parser.SyntaxNode, kind: ExpressionFact["kind"]): ExpressionFact => {
      const value = { localId: next("expression"), kind, text: node.text, ownerScopeId: scopeStack.at(-1), range: range(node) }; expressions.push(value); return value;
    };
    const visit = (node: Parser.SyntaxNode): void => {
      const isScope = ["source_file", "mod_item", "struct_item", "enum_item", "trait_item", "impl_item", "function_item", "block"].includes(node.type);
      if (isScope) { const scope = { localId: next("scope"), kind: node.type, name: text(field(node, "name")) ?? text(node.namedChildren.find((child) => ["identifier", "type_identifier"].includes(child.type))), parentId: scopeStack.at(-1), range: range(node) }; scopes.push(scope); scopeStack.push(scope.localId); }
      let declared: ParsedSymbolFact | undefined;
      if (node.type === "mod_item") {
        const name = text(field(node, "name")) ?? text(node.namedChildren.find((child) => child.type === "identifier"));
        if (name) { declared = addSymbol(node, "module", name); modules.push({ localId: next("module"), name, moduleKind: "module", exported: node.text.includes("pub"), range: range(node) }); }
      } else if (node.type === "use_declaration") {
        const clause = node.namedChildren[0];
        const aliasNode = clause?.type === "use_as_clause" ? clause.namedChildren.at(-1) : undefined;
        const targetNode = clause?.type === "use_as_clause" ? clause.namedChildren[0] : clause;
        const target = text(targetNode); const localName = text(aliasNode) ?? unqualified(target ?? "");
        if (target) { imports.push({ localId: next("import"), moduleSpecifier: target, importedName: unqualified(target), localName, kind: "use", range: range(node) }); aliases.push({ localId: next("alias"), aliasName: localName, targetName: target, aliasKind: "import", range: range(node) }); bindings.push({ localId: next("binding"), name: localName, bindingKind: "import", sourceModule: target, importedName: unqualified(target), ownerId: scopeStack.at(-1), range: range(node) }); }
      } else if (node.type === "struct_item") {
        const name = text(node.namedChildren.find((child) => child.type === "type_identifier")); if (name) { declared = addSymbol(node, "class", name); typeStack.push(declared); }
      } else if (node.type === "enum_item") {
        const name = text(node.namedChildren.find((child) => child.type === "type_identifier")); if (name) { declared = addSymbol(node, "enum", name); typeStack.push(declared); }
      } else if (node.type === "trait_item") {
        const name = text(node.namedChildren.find((child) => child.type === "type_identifier")); if (name) { declared = addSymbol(node, "interface", name); typeStack.push(declared); }
      } else if (node.type === "impl_item") {
        const typesInImpl = node.namedChildren.filter((child) => child.type === "type_identifier").map((child) => child.text);
        const subject = typesInImpl.at(-1); const trait = typesInImpl.length > 1 ? typesInImpl[0] : undefined;
        if (subject) { const owner = symbolByName.get(unqualified(subject))?.find((item) => item.kind === "class"); if (owner) { typeStack.push(owner); if (trait) implementations.push({ localId: next("implementation"), subjectId: owner.localId, targetName: trait, relationKind: "trait_impl", range: range(node) }); } }
      } else if (node.type === "function_item") {
        const name = text(field(node, "name")) ?? text(node.namedChildren.find((child) => child.type === "identifier"));
        if (name) { const owner = typeStack.at(-1); declared = addSymbol(node, "method", name, owner ? `${owner.name}::${name}` : name); callableStack.push(declared); if (owner) members.push({ localId: next("member"), ownerSymbolId: owner.localId, memberName: name, memberKind: "method", access: node.parent?.parent?.type === "impl_item" && node.parent?.parent.text.includes(" for ") ? "instance" : "static", range: range(node) }); }
      } else if (node.type === "field_declaration") {
        const name = text(field(node, "name")); if (name && typeStack.at(-1)) { const member = addSymbol(node, "variable", name, `${typeStack.at(-1)!.name}::${name}`); members.push({ localId: next("member"), ownerSymbolId: typeStack.at(-1)!.localId, memberName: name, memberKind: "field", access: "instance", range: range(node) }); const typeNode = field(node, "type"); if (typeNode) types.push({ localId: next("type"), ownerId: member.localId, text: typeNode.text, range: range(typeNode) }); }
      } else if (node.type === "parameter") {
        const name = text(field(node, "pattern")) ?? text(node.namedChildren.find((child) => child.type === "identifier")); const typeNode = field(node, "type");
        if (name && callableStack.at(-1)) { const binding = { localId: next("binding"), name, bindingKind: "parameter", ownerId: callableStack.at(-1)!.localId, range: range(node) }; bindings.push(binding); parameters.push({ localId: next("parameter"), ownerSymbolId: callableStack.at(-1)!.localId, name, bindingId: binding.localId, typeText: typeNode?.text, index: parameters.filter((item) => item.ownerSymbolId === callableStack.at(-1)!.localId).length, receiverKind: name === "self" ? "method_receiver" : undefined, range: range(node) }); if (typeNode) types.push({ localId: next("type"), ownerId: binding.localId, text: typeNode.text, range: range(typeNode) }); }
      } else if (node.type === "let_declaration") {
        const target = node.namedChildren.find((child) => child.type === "identifier"); const value = node.namedChildren.find((child) => child.type === "call_expression" || child.type === "field_expression") ?? node.namedChildren.find((child) => child.type === "identifier" && child !== target);
        if (target) { const binding = { localId: next("binding"), name: target.text, bindingKind: "let", ownerId: scopeStack.at(-1), range: range(target) }; bindings.push(binding); const expression = value ? addExpression(value, value.type === "call_expression" ? "call" : value.type === "field_expression" ? "member" : "identifier") : undefined; assignments.push({ localId: next("assignment"), targetId: binding.localId, sourceExpressionId: expression?.localId, sourceName: value?.type === "identifier" ? value.text : undefined, assignmentKind: "declaration", range: range(node) }); if (value?.type === "call_expression") { const typeName = text(value.namedChildren[0])?.split("::").at(0); if (typeName) constructors.push({ localId: next("constructor"), ownerSymbolId: callableStack.at(-1)?.localId, constructedTypeName: typeName, callExpressionId: expression?.localId, resultBindingId: binding.localId, range: range(value) }); } }
      } else if (node.type === "call_expression" || node.type === "macro_invocation") {
        const callee = node.type === "macro_invocation" ? text(node.namedChildren[0]) : text(node.namedChildren[0]); if (callee) calls.push({ localId: next("call"), calleeText: callee, callerId: callableStack.at(-1)?.localId, scopeId: scopeStack.at(-1), range: range(node) });
      } else if (node.type === "field_expression") {
        const name = text(field(node, "field")); const value = field(node, "value"); if (name && value) members.push({ localId: next("member"), receiverId: addExpression(value, value.type === "identifier" ? "identifier" : "other").localId, memberName: name, memberKind: "method", access: "instance", range: range(node) });
      } else if (node.type === "return_type") {
        const owner = callableStack.at(-1); const typeNode = node.namedChildren[0]; if (owner && typeNode) returns.push({ localId: next("return"), ownerSymbolId: owner.localId, typeText: typeNode.text, range: range(node) });
      } else if (node.type === "identifier" && node.parent?.type !== "use_as_clause") references.push({ localId: next("reference"), name: node.text, ownerId: callableStack.at(-1)?.localId, scopeId: scopeStack.at(-1), range: range(node) });
      for (const child of node.namedChildren) visit(child);
      if (node.type === "function_item" && declared) callableStack.pop();
      if (["struct_item", "enum_item", "trait_item"].includes(node.type) && declared) typeStack.pop();
      if (node.type === "impl_item" && typeStack.length) typeStack.pop();
      if (isScope) scopeStack.pop();
    };
    visit(parsed.tree.rootNode);
    modules.push({ localId: next("module"), name: input.filePath, moduleKind: "file", exported: false, range: range(parsed.tree.rootNode) });
    const diagnostics: string[] = [];
    const collect = (node: Parser.SyntaxNode): void => { if (node.type === "ERROR" || node.isMissing) diagnostics.push(`${node.type}@${node.startPosition.row + 1}:${node.startPosition.column}`); for (const child of node.children) collect(child); };
    collect(parsed.tree.rootNode);
    return { kind: "facts", facts: { factsSchemaVersion: input.factsSchemaVersion, factsVersion: input.factsVersion, contentHash: input.contentHash, language: "rust", parserIdentity: { language: parsed.adapter.language, ...parsed.adapter.metadata }, parseStatus: diagnostics.length ? "deterministic_partial" : "complete", parserDiagnostics: [...new Set(diagnostics)], symbols, containmentScopes: scopes, imports, exports: [], references, callSites: calls, bindingSeeds: bindings, declaredTypeAnnotations: types, expressions, members, assignments, parameters, returns, constructors, inheritances, implementations, aliases, modules, namespaces: [] } };
  } catch (error) { return { kind: "infrastructure_failure", error: error instanceof Error ? error : new Error(String(error)) }; }
}

export const rustFactExtractor: LanguageFactExtractor = { language: "rust", extract: extractRustFacts };
